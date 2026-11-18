(() => {
  "use strict";

  // ℏ² / (2mₑ) in eV·nm². All solver coordinates use nm.
  const ELECTRON_KINETIC = 0.0380998212;
  const presets = {
    rectangle: () => 1,
    triangle: t => 1 - Math.abs(2 * t - 1),
    parabola: t => 4 * t * (1 - t),
    double: t => 0.08 + 0.92 * Math.sin(2 * Math.PI * t) ** 2,
  };

  function expression(source) {
    const functions = {
      abs: Math.abs, sqrt: Math.sqrt, exp: Math.exp, log: Math.log,
      sin: Math.sin, cos: Math.cos, tan: Math.tan,
    };
    const tokens = source.match(/(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[a-z]+|[^\s]/gi) || [];
    if (tokens.length > 150 || source.length > 500) {
      throw new Error("Формула слишком длинная.");
    }
    let index = 0;
    const invalid = () => { throw new Error("Проверьте формулу и знаки умножения."); };
    function expect(token) {
      if (tokens[index++] !== token) invalid();
    }
    function primary() {
      const token = tokens[index++];
      if (token === "(") {
        const value = sum();
        expect(")");
        return value;
      }
      if (token === "x") return x => x;
      if (token === "L") return (x, L) => L;
      if (token === "pi") return () => Math.PI;
      if (token && /^[\d.]/.test(token) && Number.isFinite(Number(token))) {
        return () => Number(token);
      }
      if (Object.hasOwn(functions, token)) {
        expect("(");
        const argument = sum();
        expect(")");
        return (x, L) => functions[token](argument(x, L));
      }
      return invalid();
    }
    function unary() {
      if (tokens[index] === "+" || tokens[index] === "-") {
        const sign = tokens[index++] === "-" ? -1 : 1;
        const value = unary();
        return (x, L) => sign * value(x, L);
      }
      const base = primary();
      if (tokens[index] !== "^") return base;
      index++;
      const exponent = unary();
      return (x, L) => base(x, L) ** exponent(x, L);
    }
    function chain(next, operations) {
      let result = next();
      while (Object.hasOwn(operations, tokens[index])) {
        const previous = result;
        const operation = operations[tokens[index++]];
        const right = next();
        result = (x, L) => operation(previous(x, L), right(x, L));
      }
      return result;
    }
    const product = () => chain(unary, { "*": (a, b) => a * b, "/": (a, b) => a / b });
    const sum = () => chain(product, { "+": (a, b) => a + b, "-": (a, b) => a - b });
    const evaluate = sum();
    if (index !== tokens.length) invalid();
    return evaluate;
  }

  function table(source, width) {
    const lines = source.trim().split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2 || lines.length > 1000) {
      throw new Error("В таблице должно быть от 2 до 1000 строк.");
    }
    const points = lines.map((line, index) => {
      const columns = line.trim().split(/\s*[,;]\s*|\s+/);
      const values = columns.map(Number);
      if (values.length !== 2 || columns.some(value => !value) || !values.every(Number.isFinite)) {
        throw new Error(`Строка ${index + 1} должна содержать два числа.`);
      }
      return values;
    });
    const last = points.length - 1;
    const tolerance = 1e-9 * Math.max(1, width);
    if (Math.abs(points[0][0]) > tolerance || Math.abs(points[last][0] - width) > tolerance) {
      throw new Error("Координаты первой и последней строк должны совпадать с 0 и L.");
    }
    points[0][0] = 0;
    points[last][0] = width;
    if (points.some(([x], i) => i > 0 && x <= points[i - 1][0])) {
      throw new Error("Координаты должны строго возрастать.");
    }
    return points;
  }

  function makeProfile(config) {
    const { mode, shape, width, height, mass, source } = config;
    if (!(width > 0 && mass > 0) || ![width, mass, height].every(Number.isFinite)) {
      throw new Error("Ширина и масса должны быть положительными.");
    }
    let points;
    let potential;
    if (shape === "formula") {
      const evaluate = expression(source);
      potential = x => evaluate(x, width);
    } else if (shape === "table") {
      points = table(source, width);
      potential = x => {
        let left = 0;
        let right = points.length - 1;
        while (right - left > 1) {
          const middle = (left + right) >> 1;
          if (x < points[middle][0]) right = middle;
          else left = middle;
        }
        const [x0, u0] = points[left];
        const [x1, u1] = points[right];
        return u0 + (u1 - u0) * (x - x0) / (x1 - x0);
      };
    } else {
      const sign = mode === "well" ? -1 : 1;
      potential = x => sign * height * presets[shape](x / width);
    }

    function sample(x) {
      const value = potential(x);
      if (!Number.isFinite(value) || Math.abs(value) > 100) {
        throw new Error("Потенциал должен быть конечным и лежать в пределах ±100 эВ.");
      }
      if (mode === "barrier" && (value < 0 || (value === 0 && x > 0 && x < width))) {
        throw new Error("Внутри барьера U(x) должен быть положительным.");
      }
      return value;
    }
    const plot = points
      ? points.map(([x]) => [x, sample(x)])
      : Array.from({ length: 321 }, (_, i) => {
          const x = width * (i / 320);
          return [x, sample(x)];
        });
    return { sample, plot, points };
  }

  function tableGridSize(points, width) {
    let shortest = Infinity;
    for (let i = 1; i < points.length; i++) {
      const [x0, u0] = points[i - 1];
      const [x1, u1] = points[i];
      if (u0 !== u1) shortest = Math.min(shortest, x1 - x0);
    }
    const required = Math.ceil(4 * width / shortest);
    let intervals = 512;
    while (intervals < required && intervals < 8192) intervals *= 2;
    return { intervals, required };
  }

  function averageTablePotential(points, intervals, width) {
    // Integrate the linear profile over each node's cell, including partial
    // cells at the ends. A feature between nodes still contributes to H.
    const dx = width / intervals;
    const potential = new Float64Array(intervals + 1);
    let segment = 1;
    let x = 0;
    for (let i = 0; i <= intervals; i++) {
      const right = i === intervals ? width : (i + 0.5) * dx;
      let integral = 0;
      while (x < right) {
        const [x0, u0] = points[segment - 1];
        const [x1, u1] = points[segment];
        const end = Math.min(right, x1);
        const mid = x + (end - x) / 2;
        const average = u0 + (u1 - u0) * ((mid - x0) / (x1 - x0));
        integral += (end - x) * average;
        x = end;
        if (x === x1 && segment < points.length - 1) segment++;
      }
      potential[i] = integral / dx;
    }
    return potential;
  }

  function tridiagonalSolve(diagonal, off, input) {
    const rhs = Float64Array.from(input);
    const pivots = Float64Array.from(diagonal);
    const floor = Math.abs(off) * 8 * Number.EPSILON;
    function guard(i) {
      if (Math.abs(pivots[i]) < floor) pivots[i] = pivots[i] < 0 ? -floor : floor;
    }
    for (let i = 1; i < rhs.length; i++) {
      guard(i - 1);
      const factor = off / pivots[i - 1];
      pivots[i] -= factor * off;
      rhs[i] -= factor * rhs[i - 1];
    }
    guard(rhs.length - 1);
    rhs[rhs.length - 1] /= pivots[rhs.length - 1];
    for (let i = rhs.length - 2; i >= 0; i--) {
      rhs[i] = (rhs[i] - off * rhs[i + 1]) / pivots[i];
    }
    return rhs;
  }

  function solveWell(config, requestedIntervals) {
    const { width, mass } = config;
    const profile = makeProfile(config);
    const grid = profile.points ? tableGridSize(profile.points, width) : { intervals: 512, required: 0 };
    const intervals = requestedIntervals ?? grid.intervals;
    const dx = width / intervals;
    const kinetic = ELECTRON_KINETIC / (mass * dx ** 2);
    const potential = profile.points
      ? averageTablePotential(profile.points, intervals, width)
      : Float64Array.from({ length: intervals + 1 }, (_, i) => {
          const weight = i === 0 || i === intervals ? 0.5 : 1;
          return weight * profile.sample(width * (i / intervals));
        });
    const diagonal = potential.map(value => 2 * kinetic + value);
    const kineticSquared = kinetic ** 2;

    // Eliminate the two semi-infinite, zero-potential lattice tails exactly.
    function decay(energy) {
      return 2 * Math.asinh(Math.sqrt(-energy / (4 * kinetic)));
    }
    function count(energy) {
      const edge = kinetic * Math.exp(-decay(energy));
      let pivot = 0;
      let total = 0;
      for (let i = 0; i <= intervals; i++) {
        const tail = i === 0 || i === intervals ? edge : 0;
        pivot = diagonal[i] - energy - tail - (i ? kineticSquared / pivot : 0);
        if (Math.abs(pivot) < kinetic * Number.EPSILON) pivot = -kinetic * Number.EPSILON;
        if (pivot < 0) total++;
      }
      return total;
    }
    const lower = Math.min(0, ...potential);
    const upper = -Math.max(1e-11, 2 * kinetic * Number.EPSILON);
    const total = lower < upper ? count(upper) : 0;
    const states = [];
    const plotStep = Math.max(1, Math.ceil(intervals / 512));
    for (let state = 0; state < total; state++) {
      let left = lower;
      let right = upper;
      for (let step = 0; step < 52; step++) {
        const middle = (left + right) / 2;
        if (count(middle) <= state) left = middle;
        else right = middle;
      }
      const energy = (left + right) / 2;
      const exponent = decay(energy);
      const edge = kinetic * Math.exp(-exponent);
      const shifted = diagonal.map(value => value - energy);
      shifted[0] -= edge;
      shifted[intervals] -= edge;
      let wave = Float64Array.from(shifted, (_, i) => Math.sin((state + 1.37) * (i + 0.5) / intervals * Math.PI));
      for (let step = 0; step < 4; step++) {
        wave = tridiagonalSolve(shifted, -kinetic, wave);
        const scale = wave.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
        wave = wave.map(value => value / scale);
      }
      const tailWeight = 1 / Math.expm1(2 * exponent);
      const exterior = tailWeight * (wave[0] ** 2 + wave[intervals] ** 2);
      const norm = Math.sqrt(dx * (wave.reduce((sum, value) => sum + value ** 2, 0) + exterior));
      const sign = wave[0] < 0 ? -1 : 1;
      wave = wave.map(value => sign * value / norm);
      const tail = Math.min(4.5 * dx / exponent, 10 * width);
      const curve = [];
      for (let i = 80; i > 0; i--) {
        const x = -tail * i / 80;
        curve.push([x, wave[0] * Math.exp(x * exponent / dx)]);
      }
      for (let i = 0; i < intervals; i += plotStep) curve.push([i * dx, wave[i]]);
      curve.push([width, wave[intervals]]);
      for (let i = 1; i <= 80; i++) {
        const x = tail * i / 80;
        curve.push([width + x, wave[intervals] * Math.exp(-x * exponent / dx)]);
      }
      states.push({ energy, curve });
    }
    return { mode: "well", width, profile: profile.plot, states, intervals, gridLimited: grid.required > intervals };
  }

  function prepareBarrier(config, intervals = 280) {
    const { width, shape } = config;
    const profile = makeProfile(config);
    const knots = profile.points?.map(([x]) => x) || [0, width];
    const segments = [];
    for (let i = 1; i < knots.length; i++) {
      const length = knots[i] - knots[i - 1];
      const count = shape === "rectangle" ? 1 : Math.max(1, Math.ceil(intervals * length / width));
      const dx = length / count;
      for (let j = 0; j < count; j++) {
        segments.push({ dx, value: profile.sample(knots[i - 1] + (j + 0.5) * dx) });
      }
    }
    return { segments, profile: profile.plot };
  }

  function transmission(segments, mass, energy) {
    const kinetic = ELECTRON_KINETIC / mass;
    const k = Math.sqrt(energy / kinetic);
    let reflectedReal = 0;
    let reflectedImaginary = 0;
    let logT = 0;
    for (let i = segments.length - 1; i >= 0; i--) {
      const { dx, value } = segments[i];
      const qSquared = (energy - value) / kinetic;
      const z = Math.sqrt(Math.abs(qSquared)) * dx;
      let cosine;
      let sineOverQ;
      let attenuation = 0;
      if (qSquared < 0) {
        attenuation = z;
        cosine = (1 + Math.exp(-2 * z)) / 2;
        sineOverQ = z ? -Math.expm1(-2 * z) * dx / (2 * z) : dx;
      } else {
        cosine = Math.cos(z);
        sineOverQ = z ? Math.sin(z) * dx / z : dx;
      }
      const denReal = 2 * cosine;
      const denImaginary = -(qSquared / k + k) * sineOverQ;
      const denNorm = denReal ** 2 + denImaginary ** 2;
      const reflectionNumerator = -(value / (kinetic * k)) * sineOverQ;
      const rReal = reflectionNumerator * denImaginary / denNorm;
      const rImaginary = reflectionNumerator * denReal / denNorm;
      const tScale = 2 * Math.exp(-attenuation) / denNorm;
      const tReal = tScale * denReal;
      const tImaginary = -tScale * denImaginary;
      const jointReal = 1 - rReal * reflectedReal + rImaginary * reflectedImaginary;
      const jointImaginary = -rReal * reflectedImaginary - rImaginary * reflectedReal;
      const jointNorm = jointReal ** 2 + jointImaginary ** 2;
      const ratioReal = (reflectedReal * jointReal + reflectedImaginary * jointImaginary) / jointNorm;
      const ratioImaginary = (reflectedImaginary * jointReal - reflectedReal * jointImaginary) / jointNorm;
      const tSquaredReal = tReal ** 2 - tImaginary ** 2;
      const tSquaredImaginary = 2 * tReal * tImaginary;
      reflectedReal = rReal + tSquaredReal * ratioReal - tSquaredImaginary * ratioImaginary;
      reflectedImaginary = rImaginary + tSquaredReal * ratioImaginary + tSquaredImaginary * ratioReal;
      logT += Math.log(4 / denNorm) - 2 * attenuation - Math.log(jointNorm);
    }
    const rawT = Math.exp(logT);
    const rawR = reflectedReal ** 2 + reflectedImaginary ** 2;
    return {
      T: Math.min(1, rawT), R: Math.min(1, rawR), logT: Math.min(0, logT),
      fluxError: Math.abs(rawR + rawT - 1),
    };
  }

  function solve(config) {
    if (config.mode === "well") return solveWell(config);
    const { segments, profile } = prepareBarrier(config);
    const peak = Math.max(...profile.map(([, value]) => value));
    const maximum = Math.max(config.energyMax, Math.ceil(1.35 * peak));
    const sweep = Array.from({ length: 321 }, (_, i) => {
      const energy = config.energyMin + (maximum - config.energyMin) * i / 320;
      return [energy, transmission(segments, config.mass, energy)];
    });
    return { mode: "barrier", width: config.width, mass: config.mass, profile, segments, sweep };
  }

  globalThis.Simulation = { solve, solveWell, prepareBarrier, transmission };
})();
