import * as THREE from "three";
import { ABILITIES, type CombatEventData } from "@mmo/shared";

/**
 * All sound in this game is synthesized with the Web Audio API — no sample
 * files. Every effect is scheduled fresh from oscillators/noise so there's
 * nothing to load, license, or ship; it mirrors the project's placeholder-GLB
 * approach (packages/shared has no audio assets, so this generates its own).
 * Browsers block audio before a user gesture, so `unlock()` must be called
 * from a real click/keydown — main.ts wires that to the first pointerdown.
 */

/** Sounds beyond this distance from the listener are inaudible. */
const AUDIBLE_RANGE = 32;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private listenerX = 0;
  private listenerZ = 0;
  /** Active cast drones, keyed by caster entity id. */
  private loops = new Map<number, { stop: () => void; x: number; z: number }>();

  /** Call from a real user gesture (click/keydown) — no-op after the first. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(ctx.destination);
  }

  setListener(x: number, z: number): void {
    this.listenerX = x;
    this.listenerZ = z;
  }

  private gainAt(x: number, z: number): number {
    const dist = Math.hypot(x - this.listenerX, z - this.listenerZ);
    return Math.max(0, 1 - dist / AUDIBLE_RANGE);
  }

  // ---------------------------------------------------------------------
  // Low-level synthesis helpers

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (!this.noise) {
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.noise = buf;
    }
    return this.noise;
  }

  /** A short filtered noise burst — the basis for hits, footsteps, whooshes. */
  private playNoiseBurst(
    peakGain: number,
    duration: number,
    opts: {
      filter?: "lowpass" | "highpass" | "bandpass";
      freqFrom?: number;
      freqTo?: number;
      q?: number;
    } = {},
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || peakGain <= 0.002) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(peakGain, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    let node: AudioNode = src;
    if (opts.filter) {
      const filt = ctx.createBiquadFilter();
      filt.type = opts.filter;
      filt.Q.value = opts.q ?? 1;
      const from = opts.freqFrom ?? 4000;
      filt.frequency.setValueAtTime(from, now);
      if (opts.freqTo !== undefined) {
        filt.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqTo), now + duration);
      }
      node.connect(filt);
      node = filt;
    }
    node.connect(gain);
    gain.connect(this.master);
    src.start(now);
    src.stop(now + duration + 0.02);
  }

  /** A short tone — the basis for chimes, dings, and cast drones. */
  private playTone(
    freqFrom: number,
    freqTo: number,
    duration: number,
    peakGain: number,
    type: OscillatorType = "sine",
    delay = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || peakGain <= 0.002) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    const gain = ctx.createGain();
    const now = ctx.currentTime + delay;
    osc.frequency.setValueAtTime(freqFrom, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqTo), now + duration);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peakGain, now + Math.min(0.02, duration * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  // ---------------------------------------------------------------------
  // Abilities — pressed (optimistic, self only) and landed (via combatEvent)

  /** Player pressed an ability key; instant tactile feedback before the server confirms. */
  playAbilityUse(id: string): void {
    switch (id) {
      case "strike":
        this.playNoiseBurst(0.5, 0.12, { filter: "bandpass", freqFrom: 2200, freqTo: 900, q: 1.2 });
        break;
      case "heavy":
        this.playNoiseBurst(0.7, 0.2, { filter: "bandpass", freqFrom: 1400, freqTo: 500, q: 1 });
        this.playTone(180, 70, 0.18, 0.3, "sawtooth");
        break;
      case "kick":
        this.playNoiseBurst(0.45, 0.07, { filter: "bandpass", freqFrom: 3000, freqTo: 1800, q: 2 });
        break;
      case "fireball":
        this.playNoiseBurst(0.4, 0.35, { filter: "lowpass", freqFrom: 3500, freqTo: 500 });
        this.playTone(300, 700, 0.3, 0.22, "sawtooth");
        break;
      case "heal":
        this.playTone(500, 900, 0.4, 0.2, "sine");
        this.playTone(750, 1150, 0.45, 0.14, "sine", 0.08);
        break;
    }
  }

  /** Ability landed (self or NPC): the confirmed hit, distance-attenuated at the target. */
  onCombatEvent(
    ev: CombatEventData,
    targetPos: THREE.Vector3 | null,
    selfId: number,
    targetIsNpc: boolean,
  ): void {
    if (!targetPos) return;
    const g = this.gainAt(targetPos.x, targetPos.z);
    if (g <= 0.01) return;
    const def = ev.ability ? ABILITIES[ev.ability] : undefined;

    if (ev.damage < 0 || def?.fx.kind === "heal") {
      this.playTone(700, 1100, 0.35, 0.22 * g, "sine");
      this.playTone(950, 1350, 0.4, 0.14 * g, "sine", 0.06);
    } else if (ev.ability === "summonPack") {
      this.playTone(180, 90, 0.5, 0.3 * g, "sawtooth");
      this.playNoiseBurst(0.3 * g, 0.4, { filter: "lowpass", freqFrom: 900, freqTo: 200 });
    } else if (ev.ability === "kick") {
      this.playNoiseBurst(0.55 * g, 0.08, { filter: "bandpass", freqFrom: 2800, freqTo: 1500, q: 2 });
      this.playTone(220, 120, 0.08, 0.2 * g, "square");
    } else if (def?.fx.kind === "projectile") {
      this.playNoiseBurst(0.5 * g, 0.14, { filter: "bandpass", freqFrom: 2500, freqTo: 400, q: 0.8 });
      this.playTone(500, 90, 0.16, 0.22 * g, "sawtooth");
    } else {
      const power = def?.fx.power ?? 1;
      this.playNoiseBurst(0.55 * g * Math.min(1.4, power), 0.1 + power * 0.05, {
        filter: "bandpass",
        freqFrom: 1800,
        freqTo: 400,
        q: 0.9,
      });
      this.playTone(150, 60, 0.12, 0.25 * g * power, "sawtooth");
    }

    if (ev.damage > 0 && ev.target === selfId) {
      // Player-only "ouch" layer, full volume — you always hear your own pain.
      this.playNoiseBurst(0.3, 0.15, { filter: "lowpass", freqFrom: 500, freqTo: 150 });
    }

    if (ev.died && ev.target !== selfId) {
      if (targetIsNpc) this.npcDeath(g);
      else this.otherPlayerDeath(g);
    }
  }

  // ---------------------------------------------------------------------
  // Casting — drone while channeling, sting on interrupt

  startCastLoop(casterId: number, ability: string, pos: THREE.Vector3): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    this.stopCastLoop(casterId, false);
    const g = this.gainAt(pos.x, pos.z);
    if (g <= 0.01) return;
    const color = ABILITIES[ability]?.fx.color ?? 0xffffff;
    // Warm hue -> lower/darker drone, cool hue -> higher/airier — free
    // variety without a sound per ability.
    const warm = ((color >> 16) & 0xff) > ((color >> 8) & 0xff);
    const base = warm ? 110 : 220;

    // Lowpass tames triangle waves down to a soft hum instead of a buzz.
    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.Q.value = 0.5;
    filt.frequency.value = warm ? 520 : 760;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.09 * g, ctx.currentTime + 0.35);
    filt.connect(gain);
    gain.connect(this.master);

    const osc1 = ctx.createOscillator();
    osc1.type = "triangle";
    osc1.frequency.value = base;
    const osc2 = ctx.createOscillator();
    osc2.type = "triangle";
    osc2.frequency.value = base * 1.5; // fifth above — consonant body, not a beat
    const osc2Gain = ctx.createGain();
    osc2Gain.gain.value = 0.4;

    // Slow, gentle vibrato (pitch, not amplitude) — reads as an incantation
    // rather than a tremolo buzz, which sits right in the ear's "roughness" band.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 2.2;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = base * 0.015;
    lfo.connect(lfoGain);
    lfoGain.connect(osc1.frequency);
    lfoGain.connect(osc2.frequency);

    osc1.connect(filt);
    osc2.connect(osc2Gain);
    osc2Gain.connect(filt);
    osc1.start();
    osc2.start();
    lfo.start();

    this.loops.set(casterId, {
      x: pos.x,
      z: pos.z,
      stop: () => {
        const t = ctx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        osc1.stop(t + 0.18);
        osc2.stop(t + 0.18);
        lfo.stop(t + 0.18);
      },
    });
  }

  stopCastLoop(casterId: number, interrupted: boolean): void {
    const loop = this.loops.get(casterId);
    if (!loop) return;
    loop.stop();
    this.loops.delete(casterId);
    if (interrupted) {
      const g = this.gainAt(loop.x, loop.z);
      this.playNoiseBurst(0.28 * g, 0.15, { filter: "highpass", freqFrom: 300, freqTo: 2000 });
      this.playTone(200, 90, 0.16, 0.16 * g, "triangle");
    }
  }

  playAbilityFail(): void {
    this.playTone(220, 140, 0.12, 0.16, "square");
  }

  // ---------------------------------------------------------------------
  // Movement

  playFootstep(x: number, z: number, running: boolean): void {
    const g = this.gainAt(x, z);
    if (g <= 0.01) return;
    this.playNoiseBurst(g * (running ? 0.08 : 0.05), 0.06, {
      filter: "lowpass",
      freqFrom: 900,
      freqTo: 250,
    });
  }

  playJump(x: number, z: number): void {
    const g = this.gainAt(x, z);
    if (g <= 0.01) return;
    this.playTone(260, 420, 0.14, 0.18 * g, "sine");
  }

  playLand(x: number, z: number): void {
    const g = this.gainAt(x, z);
    if (g <= 0.01) return;
    this.playNoiseBurst(g * 0.3, 0.1, { filter: "lowpass", freqFrom: 700, freqTo: 150 });
  }

  // ---------------------------------------------------------------------
  // Death

  private npcDeath(g: number): void {
    this.playNoiseBurst(0.35 * g, 0.3, { filter: "lowpass", freqFrom: 800, freqTo: 100 });
    this.playTone(220, 60, 0.3, 0.2 * g, "sawtooth");
  }

  private otherPlayerDeath(g: number): void {
    this.playTone(300, 90, 0.5, 0.2 * g, "sine");
  }

  /** The local player died — always full volume, the somber "you died" stinger. */
  playPlayerDeathSelf(): void {
    this.playTone(320, 70, 0.9, 0.3, "sine");
    this.playTone(240, 55, 0.9, 0.2, "sine", 0.12);
  }

  // ---------------------------------------------------------------------
  // Quests / UI

  playQuestAccept(): void {
    this.playTone(440, 660, 0.18, 0.16, "triangle");
    this.playTone(660, 880, 0.2, 0.14, "triangle", 0.1);
  }

  playObjectiveTick(): void {
    this.playTone(600, 700, 0.08, 0.12, "sine");
  }

  playQuestComplete(): void {
    this.playTone(520, 520, 0.14, 0.18, "triangle");
    this.playTone(660, 660, 0.14, 0.18, "triangle", 0.1);
    this.playTone(880, 880, 0.22, 0.2, "triangle", 0.2);
  }

  playLevelUp(): void {
    this.playTone(440, 440, 0.12, 0.2, "triangle");
    this.playTone(550, 550, 0.12, 0.2, "triangle", 0.09);
    this.playTone(660, 660, 0.12, 0.2, "triangle", 0.18);
    this.playTone(880, 880, 0.3, 0.24, "triangle", 0.27);
  }
}
