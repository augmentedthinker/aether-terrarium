/**
 * connectome-engine.js — Real-Time Leaky Integrate-and-Fire (LIF) Connectome Subcircuit
 * 
 * Implements the 443-neuron, 20,281-synapse Drosophila feeding reflex subcircuit
 * extracted from FlyWire v630 (Shiu et al., Nature 2024).
 * Runs 100% locally in browser memory with sub-millisecond per-frame compute.
 */

export class ConnectomeEngine {
  constructor() {
    this.ready = false;
    this.neuronCount = 0;
    this.synapseCount = 0;

    // Biological constants (Shiu et al. 2024)
    this.v_0 = -52.0;       // resting potential (mV)
    this.v_rst = -52.0;     // reset potential (mV)
    this.v_th = -45.0;      // spike threshold (mV)
    this.t_mbr = 20.0;      // membrane time scale (ms)
    this.tau = 5.0;         // synaptic decay time (ms)
    this.t_rfc = 2.2;       // refractory period (ms)
    this.t_dly = 1.8;       // transmission delay (ms)
    this.w_syn = 0.275;     // global synaptic scale (mV per connectivity unit)
    this.f_poi = 250;       // Poisson input scaling factor
    this.dt = 0.1;          // simulation timestep (ms)

    // Precalculated integration coefficients
    this.decay_v = this.dt / this.t_mbr;
    this.decay_g = this.dt / this.tau;
    this.delay_steps = Math.round(this.t_dly / this.dt); // 18 steps

    // State arrays
    this.v = null;
    this.g = null;
    this.rfc = null;

    // Topology
    this.adjPost = null;
    this.adjWeight = null;
    this.sugarIndices = [];
    this.bitterIndices = [];
    this.motorIndices = [];
    this.neurons = [];

    // Circular synaptic delivery ring
    this.ring = [];
    this.ringHead = 0;

    // Telemetry & metrics
    this.simulatedTimeMs = 0;
    this.totalSpikesFired = 0;
    this.motorSpikes1 = 0;
    this.motorSpikes2 = 0;
    this.recentMotorSpikeTimestamps = []; // for exponential mouth displacement
    this.recentVoltagesMN9 = []; // for oscilloscope display
    this.activeNeuronMask = null;
  }

  async loadFromUrl(url) {
    const res = await fetch(url);
    const data = await res.json();
    this.initialize(data);
  }

  initialize(data) {
    this.neuronCount = data.neuronCount;
    this.synapseCount = data.synapseCount;
    this.neurons = data.neurons;

    const N = this.neuronCount;
    this.v = new Float32Array(N).fill(this.v_0);
    this.g = new Float32Array(N);
    this.rfc = new Float32Array(N);
    this.activeNeuronMask = new Uint8Array(N);

    // Filter index sets
    this.sugarIndices = data.neurons.filter(n => n.type === 'sugar').map(n => n.idx);
    this.bitterIndices = data.neurons.filter(n => n.type === 'bitter').map(n => n.idx);
    this.motorIndices = data.neurons.filter(n => n.type === 'motor').map(n => n.idx);

    // Build compact adjacency lists
    const counts = new Int32Array(N);
    for (let i = 0; i < data.synapses.length; i++) {
      counts[data.synapses[i][0]]++;
    }

    this.adjPost = new Array(N);
    this.adjWeight = new Array(N);
    for (let i = 0; i < N; i++) {
      this.adjPost[i] = new Int32Array(counts[i]);
      this.adjWeight[i] = new Float32Array(counts[i]);
    }

    const cur = new Int32Array(N);
    for (let i = 0; i < data.synapses.length; i++) {
      const syn = data.synapses[i];
      const pre = syn[0];
      const post = syn[1];
      const w = syn[2];
      const p = cur[pre]++;
      this.adjPost[pre][p] = post;
      this.adjWeight[pre][p] = w;
    }

    // Allocate ring buffer (capacity: delay_steps + 1)
    this.ring = Array.from({ length: this.delay_steps + 1 }, () => []);
    this.ringHead = 0;
    this.ready = true;
  }

  reset() {
    if (!this.ready) return;
    this.v.fill(this.v_0);
    this.g.fill(0);
    this.rfc.fill(0);
    this.activeNeuronMask.fill(0);
    for (let i = 0; i < this.ring.length; i++) this.ring[i].length = 0;
    this.simulatedTimeMs = 0;
    this.totalSpikesFired = 0;
    this.motorSpikes1 = 0;
    this.motorSpikes2 = 0;
    this.recentMotorSpikeTimestamps = [];
    this.recentVoltagesMN9 = [];
  }

  /**
   * Run one 0.1ms integration step
   */
  step(sugarHz = 0, bitterHz = 0) {
    const N = this.neuronCount;
    const dt = this.dt;
    const ringLen = this.delay_steps + 1;
    const ringIdx = this.ringHead % ringLen;
    const currentDeliveries = this.ring[ringIdx];

    // 1. Deliver arrived delayed post-synaptic potentials
    for (let q = 0; q < currentDeliveries.length; q += 2) {
      this.g[currentDeliveries[q]] += currentDeliveries[q + 1];
    }
    currentDeliveries.length = 0;

    // 2. Sensory input (Poisson drive)
    const poiScale = this.f_poi * this.w_syn; // ~68.75 mV per spike
    if (sugarHz > 0) {
      const pSugar = sugarHz * 0.001 * dt;
      for (let s = 0; s < this.sugarIndices.length; s++) {
        if (Math.random() < pSugar) {
          this.g[this.sugarIndices[s]] += poiScale;
        }
      }
    }
    if (bitterHz > 0) {
      const pBitter = bitterHz * 0.001 * dt;
      for (let b = 0; b < this.bitterIndices.length; b++) {
        if (Math.random() < pBitter) {
          this.g[this.bitterIndices[b]] += poiScale;
        }
      }
    }

    // 3. Integrate Leaky Integrate-and-Fire equations
    const targetRing = (this.ringHead + this.delay_steps) % ringLen;
    const targetQueue = this.ring[targetRing];
    const mn9_1 = this.motorIndices[0];
    const mn9_2 = this.motorIndices[1];
    let frameSpikes = 0;

    for (let i = 0; i < N; i++) {
      if (this.rfc[i] > 0) {
        this.rfc[i] -= dt;
        this.v[i] = this.v_rst;
      } else {
        // dv/dt = (v_0 - v + g) / t_mbr
        // dg/dt = -g / tau
        this.v[i] += this.decay_v * (this.v_0 - this.v[i] + this.g[i]);
        this.g[i] += this.decay_g * (-this.g[i]);

        if (this.v[i] >= this.v_th) {
          // Action potential triggered!
          frameSpikes++;
          this.totalSpikesFired++;
          this.activeNeuronMask[i] = 1;
          this.v[i] = this.v_rst;
          this.g[i] = 0;
          this.rfc[i] = this.t_rfc;

          // Driven sensory cells have 0 refractory period per author model
          if (sugarHz > 0 && this.sugarIndices.includes(i)) this.rfc[i] = 0;
          if (bitterHz > 0 && this.bitterIndices.includes(i)) this.rfc[i] = 0;

          // Track motor spikes
          if (i === mn9_1) {
            this.motorSpikes1++;
            this.recentMotorSpikeTimestamps.push(this.simulatedTimeMs);
          } else if (i === mn9_2) {
            this.motorSpikes2++;
            this.recentMotorSpikeTimestamps.push(this.simulatedTimeMs);
          }

          // Schedule transmission after delay
          const posts = this.adjPost[i];
          const weights = this.adjWeight[i];
          for (let p = 0; p < posts.length; p++) {
            targetQueue.push(posts[p], weights[p]);
          }
        }
      }
    }

    this.simulatedTimeMs += dt;
    this.ringHead++;
    return frameSpikes;
  }

  /**
   * Run one animation frame (e.g. 16.67ms = ~166 steps of 0.1ms)
   */
  updateFrame(deltaSeconds, sugarHz = 0, bitterHz = 0) {
    if (!this.ready) return null;
    const steps = Math.min(Math.round((deltaSeconds * 1000) / this.dt), 300);
    const mn9_1 = this.motorIndices[0];
    const mn9_2 = this.motorIndices[1];
    let spikesInBatch = 0;

    for (let s = 0; s < steps; s++) {
      spikesInBatch += this.step(sugarHz, bitterHz);
    }

    // Retain voltage snapshot for oscilloscope
    const v1 = mn9_1 !== undefined ? this.v[mn9_1] : this.v_0;
    const v2 = mn9_2 !== undefined ? this.v[mn9_2] : this.v_0;
    this.recentVoltagesMN9.push({ t: this.simulatedTimeMs, v1, v2 });
    if (this.recentVoltagesMN9.length > 300) {
      this.recentVoltagesMN9.shift();
    }

    // Prune motor spikes older than 1.5 seconds from displacement window
    const cutoff = this.simulatedTimeMs - 1500;
    while (this.recentMotorSpikeTimestamps.length > 0 && this.recentMotorSpikeTimestamps[0] < cutoff) {
      this.recentMotorSpikeTimestamps.shift();
    }

    // Calculate proboscis extension (exponential decay accumulator, tau=100ms)
    // Matches Shiu/Astra formula: sum(exp(-(t_now - t_spike)/100ms))
    let signal = 0;
    for (let i = 0; i < this.recentMotorSpikeTimestamps.length; i++) {
      const dt = this.simulatedTimeMs - this.recentMotorSpikeTimestamps[i];
      if (dt >= 0) signal += Math.exp(-dt / 100.0);
    }
    // Normalization: signal saturates smoothly up to 1.0 (proboscis fully extended)
    // 12-15 spikes within 100ms window gives maximal extension
    const extension = Math.min(signal / 12.0, 1.0);

    return {
      simulatedTimeMs: this.simulatedTimeMs,
      v1,
      v2,
      spikesInBatch,
      motorSpikes1: this.motorSpikes1,
      motorSpikes2: this.motorSpikes2,
      activeMotorSum: this.motorSpikes1 + this.motorSpikes2,
      extension
    };
  }
}
