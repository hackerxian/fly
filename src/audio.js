// 全部音效由 WebAudio 实时合成：发动机/螺旋桨、气流、失速告警、地面滑跑、接地
export class Sound {
  // 浏览器要求用户操作后才能发声，所以在「开始飞行」时调用
  start() {
    if (this.ctx) return;
    const ctx = (this.ctx = new AudioContext());
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);

    // 发动机：点火基频及其谐波 → 低通滤波
    this.engineFilter = ctx.createBiquadFilter();
    this.engineGain = ctx.createGain();
    this.engineGain.connect(this.engineFilter).connect(this.master);
    this.engineOsc = [[1, 'sawtooth', 0.5], [0.5, 'sawtooth', 0.6], [2, 'square', 0.15], [1.5, 'triangle', 0.3]].map(([ratio, type, level]) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = type;
      gain.gain.value = level;
      osc.connect(gain).connect(this.engineGain);
      osc.start();
      return { frequency: osc.frequency, ratio };
    });

    // 一段循环白噪声，分别滤成气流声、螺旋桨噪声与轮胎滚动声
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = ctx.createBufferSource();
    this.noise.buffer = buffer;
    this.noise.loop = true;
    this.noise.start();
    const band = (type, freq, q = 0.7) => {
      const filter = ctx.createBiquadFilter(), gain = ctx.createGain();
      Object.assign(filter, { type }).frequency.value = freq;
      filter.Q.value = q;
      gain.gain.value = 0;
      this.noise.connect(filter).connect(gain).connect(this.master);
      return { gain: gain.gain, frequency: filter.frequency };
    };
    this.wind = band('bandpass', 500, 0.6);
    this.propNoise = band('bandpass', 1400, 0.8);
    this.rumble = band('lowpass', 90);

    // 失速告警喇叭
    this.horn = ctx.createGain();
    this.horn.gain.value = 0;
    this.horn.connect(this.master);
    for (const f of [1480, 1495]) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = f;
      osc.connect(this.horn);
      osc.start();
    }
  }

  /** @param s 飞机状态；muted 暂停/坠毁时静音 */
  update(s, muted) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, set = (param, v) => param.setTargetAtTime(v, t, 0.06);
    set(this.master.gain, muted ? 0 : 0.5);
    const firing = Math.max(s.rpm / 30, 4); // 四缸四冲程：每转两次点火
    const load = s.engineOn ? 0.35 + 0.65 * s.controls.throttle : 0.15;
    for (const { frequency, ratio } of this.engineOsc) set(frequency, firing * ratio);
    set(this.engineGain.gain, Math.min(1, s.rpm / 500) * load * 0.5);
    set(this.engineFilter.frequency, 250 + s.rpm * 0.45 * load);
    set(this.propNoise.gain, (s.rpm / 2700) ** 2 * 0.1);
    set(this.wind.gain, Math.min((s.tas / 60) ** 2, 2.5) * 0.16);
    set(this.wind.frequency, 350 + s.tas * 7);
    set(this.rumble.gain, s.onGround ? Math.min(Math.hypot(s.vel.x, s.vel.y) / 25, 1) * 0.9 : 0);
    set(this.horn.gain, s.stallWarn ? 0.035 : 0);
  }

  // 接地瞬间的轮胎声，强度随下沉率增大
  touchdown(sink) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const filter = this.ctx.createBiquadFilter(), gain = this.ctx.createGain();
    Object.assign(filter, { type: 'bandpass' }).frequency.value = 900;
    gain.gain.setValueAtTime(Math.min(0.25 + sink * 0.25, 1), t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    this.noise.connect(filter).connect(gain).connect(this.master);
    setTimeout(() => gain.disconnect(), 500);
  }
}
