/*
 * WebGL2 renderer: uploads the current frame, converts camera log -> Rec.709
 * and applies a 3D LUT on the GPU. One context draws both the main preview and
 * the LUT thumbnails (thumbnails go through an offscreen framebuffer).
 */
(function (root) {
  'use strict';
  const CS = root.ColorScience;

  class Renderer {
    constructor(canvas) {
      const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
      if (!gl) throw new Error('WebGL2 is not available');
      this.gl = gl;
      this.canvas = canvas;
      this.luts = new Map();
      this.sourceW = 0;
      this.sourceH = 0;
      this.halfFloat = true;

      this.program = this.link(CS.VERTEX_SHADER, CS.FRAGMENT_SHADER);
      gl.useProgram(this.program);
      this.u = {};
      const n = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const name = gl.getActiveUniform(this.program, i).name;
        this.u[name] = gl.getUniformLocation(this.program, name);
      }

      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(this.program, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      this.image = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.image);
      this.texParams(gl.TEXTURE_2D);
      gl.uniform1i(this.u.uImage, 0);
      gl.uniform1i(this.u.uLut, 1);

      // Placeholder 3D texture so the sampler is always complete.
      this.emptyLut = this.makeLutTexture({ size: 2, data: new Float32Array(24) });

      this.fbo = gl.createFramebuffer();
      this.fboTex = gl.createTexture();
      this.fboW = 0;
      this.fboH = 0;
    }

    link(vs, fs) {
      const gl = this.gl;
      const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    }

    texParams(target) {
      const gl = this.gl;
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    }

    makeLutTexture(lut) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, tex);
      this.texParams(gl.TEXTURE_3D);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data);
      gl.activeTexture(gl.TEXTURE0);
      return { tex, size: lut.size };
    }

    addLut(id, lut) {
      this.removeLut(id);
      this.luts.set(id, this.makeLutTexture(lut));
    }

    removeLut(id) {
      const t = this.luts.get(id);
      if (t) { this.gl.deleteTexture(t.tex); this.luts.delete(id); }
    }

    // Upload the current video frame / image / canvas. Tries half-float first to keep 10-bit precision.
    upload(source) {
      const gl = this.gl;
      const w = source.videoWidth || source.naturalWidth || source.width;
      const h = source.videoHeight || source.naturalHeight || source.height;
      if (!w || !h) return false;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.image);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      if (this.halfFloat) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, source);
        if (gl.getError() !== gl.NO_ERROR) this.halfFloat = false;
      }
      if (!this.halfFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      this.sourceW = w;
      this.sourceH = h;
      return true;
    }

    setUniforms(p, lutId, split) {
      const gl = this.gl;
      const cam = p.camera;
      gl.uniform1i(this.u.uCurve, CS.CURVES[cam.curve].id);
      gl.uniformMatrix3fv(this.u.uGamut, false, CS.toColumnMajor(CS.gamutToRec709(cam.gamut)));
      gl.uniform1i(this.u.uTone, p.tone === 'clip' ? 1 : 0);
      gl.uniform1f(this.u.uExposure, p.exposure);
      gl.uniform1i(this.u.uFullRange, p.fullRange ? 1 : 0);
      const lut = lutId ? this.luts.get(lutId) : null;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, lut ? lut.tex : this.emptyLut.tex);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(this.u.uHasLut, lut ? 1 : 0);
      gl.uniform1f(this.u.uLutSize, lut ? lut.size : 2);
      gl.uniform1i(this.u.uLutLogInput, p.lutLogInput ? 1 : 0);
      gl.uniform1f(this.u.uIntensity, p.intensity);
      gl.uniform1f(this.u.uSplit, split);
      gl.uniform1i(this.u.uShowOriginal, p.showOriginal ? 1 : 0);
      gl.uniform2f(this.u.uScale, 1, 1);
    }

    render(p) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.setUniforms(p, p.lutId, p.split);
      gl.uniform1f(this.u.uFlipY, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // Render the current source through one LUT into a small ImageData.
    renderThumb(p, lutId, logInput, w, h) {
      const gl = this.gl;
      if (this.fboW !== w || this.fboH !== h) {
        gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        this.texParams(gl.TEXTURE_2D);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
        gl.bindTexture(gl.TEXTURE_2D, this.image);
        this.fboW = w;
        this.fboH = h;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, w, h);
      this.setUniforms({ ...p, lutLogInput: logInput, intensity: 1, showOriginal: false }, lutId, -1);
      gl.uniform1f(this.u.uFlipY, 0); // readPixels is bottom-up, so render upside down
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const px = new Uint8ClampedArray(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return new ImageData(px, w, h);
    }
  }

  root.LutRenderer = Renderer;
})(window);
