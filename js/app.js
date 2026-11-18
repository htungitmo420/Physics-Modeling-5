(() => {
  "use strict";

  const byId = id => document.getElementById(id);
  const modeButtons = [...document.querySelectorAll("[data-mode]")];
  const { colors, number } = Charts;
  const defaultSettings = {
    well: { width: 2, height: 1, mass: 1, energy: 0.2, shape: "rectangle", formula: "-4*(x/L)*(1-x/L)", table: "", selected: 0 },
    barrier: { width: 1, height: 0.4, mass: 1, energy: 0.2, shape: "rectangle", formula: "0.1+1.2*(x/L)*(1-x/L)", table: "", selected: 0 },
  };
  const settings = { well: { ...defaultSettings.well }, barrier: { ...defaultSettings.barrier } };
  const potentialCanvas = byId("potential");
  const responseCanvas = byId("response");
  let mode = "well";
  let result;
  let timer;
  let frame;
  let previousEnergy = 0;
  const current = () => settings[mode];
  const line = (points, color = colors[0]) => ({ points, color });
  const runner = Charts.scheduler(receive, message => {
    status(result ? message + " Показан предыдущий результат." : message, true);
  });

  function status(message, error = false) {
    const label = byId("status");
    label.textContent = message;
    label.classList.toggle("error", error);
  }

  function renderControls() {
    const data = current();
    const well = mode === "well";
    for (const button of modeButtons) button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    byId("well-results").hidden = !well;
    byId("barrier-results").hidden = well;
    byId("state-field").hidden = !well;
    byId("state").disabled = !result?.states?.length;
    if (byId("state").disabled) byId("state").replaceChildren(new Option("—", ""));
    byId("energy-field").hidden = well;
    byId("exact-mass-field").hidden = well;
    byId("scale-field").hidden = well;
    byId("response-title").textContent = well ? "Собственная функция ψ(x)" : "Вероятность прохождения T(E)";
    responseCanvas.setAttribute("aria-label", well ? "График собственной функции" : "Зависимость вероятности прохождения от энергии");
    byId("width-label").textContent = well ? "Ширина ямы a" : "Ширина барьера h";
    byId("height-label").textContent = well ? "Глубина ямы" : "Высота барьера";
    byId("shape").value = data.shape;
    byId("formula").value = data.formula;
    byId("profile-table").value = data.table;
    renderShape();
    renderValues();
  }

  function renderShape() {
    const { shape } = current();
    byId("expression-field").hidden = shape !== "formula";
    byId("table-field").hidden = shape !== "table";
    byId("height-field").hidden = shape === "table" || shape === "formula";
    byId("apply").hidden = shape !== "table" && shape !== "formula";
  }

  function renderValues() {
    const { width, height, mass, energy } = current();
    byId("width").value = width;
    byId("height").value = height;
    byId("mass").value = mass;
    byId("energy").max = result?.sweep?.at(-1)[0] || Math.max(3, Math.ceil(energy));
    byId("energy").value = energy;
    byId("exact-mass").value = mass;
    byId("exact-energy").value = energy;
    byId("width-value").textContent = number(width) + " нм";
    byId("height-value").textContent = number(height) + " эВ";
    byId("mass-value").textContent = number(mass);
    byId("energy-value").textContent = number(energy) + " эВ";
  }

  function requestSolve() {
    runner.invalidate();
    clearTimeout(timer);
    status("Выполняется расчёт…");
    timer = setTimeout(() => {
      const { shape, width, height, mass, energy, formula, table } = current();
      runner.run({
        mode, shape, width, height, mass,
        source: shape === "formula" ? formula : table,
        energyMin: Math.min(0.001, energy),
        energyMax: Math.max(3, Math.ceil(energy)),
      });
    }, 55);
  }

  function receive(response) {
    result = response;
    previousEnergy = 0;
    if (response.mode === "well") {
      const { states } = response;
      const data = current();
      data.selected = Math.min(data.selected, Math.max(0, states.length - 1));
      const select = byId("state");
      select.replaceChildren(...(states.length ? states.map(({ energy }, i) =>
        new Option("n = " + (i + 1) + " · " + number(energy, 6) + " эВ", i)
      ) : [new Option("Нет связанных состояний", "")]));
      select.disabled = !states.length;
      select.value = states.length ? data.selected : "";
      byId("well-summary").textContent = states.length
        ? "Найдено уровней: " + states.length + ". Выберите уровень в списке «Состояние»."
        : "Связанных состояний с E < 0 не найдено.";
      status("Готово · потенциал вне ямы равен нулю.");
    } else {
      renderValues();
      status("Готово · потенциал вне барьера равен нулю.");
    }
    redraw();
  }

  function redraw() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function draw() {
    frame = undefined;
    if (!result) {
      for (const canvas of [potentialCanvas, responseCanvas]) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
      byId("potential-legend").textContent = "";
      return;
    }
    const { width, profile } = result;
    const data = current();
    const well = mode === "well";
    const state = result.states?.[data.selected];
    const energy = well ? state?.energy : data.energy;
    const domain = state ? [state.curve[0][0], state.curve.at(-1)[0]] : [-0.23 * width, 1.23 * width];
    const extended = [[domain[0], 0], [0, 0], ...profile, [width, 0], [domain[1], 0]];
    const energyLabel = well ? "Eₙ" : "E";
    byId("potential-legend").textContent = Number.isFinite(energy)
      ? energyLabel + " = " + number(energy, 5) + " эВ" : "";
    Charts.plot(potentialCanvas, {
      xDomain: domain, yDomain: Charts.limits([line(extended), line([[0, energy ?? 0]])]),
      xLabel: "x, нм", yLabel: "U, эВ", series: [line(extended, colors[1])],
      zones: [{ axis: "x", from: 0, to: width }],
      guides: Number.isFinite(energy) ? [{ axis: "y", value: energy, color: colors[2] }] : [],
    });

    if (well) {
      const series = state ? [line(state.curve)] : [];
      const peak = state ? Math.max(...state.curve.map(([, value]) => Math.abs(value))) : 1;
      const vertical = 1.12 * peak;
      Charts.plot(responseCanvas, {
        xDomain: domain, yDomain: [-vertical, vertical],
        xLabel: "x, нм", yLabel: "ψ, нм⁻¹ᐟ²", series,
        guides: [{ axis: "y", value: 0 }],
        zones: [{ axis: "x", from: 0, to: width }],
      });
      return;
    }

    const logarithmic = byId("log-scale").checked;
    if (previousEnergy !== data.energy) {
      const selected = Simulation.transmission(result.segments, result.mass, data.energy);
      const shown = selected.T >= 1e-4 ? number(selected.T, 6) : "10^(" + number(selected.logT / Math.LN10, 2) + ")";
      byId("transmission").textContent = shown;
      byId("reflection").textContent = number(selected.R, 6);
      byId("flux-error").textContent = number(selected.fluxError, 6);
      result.selected = selected;
      previousEnergy = data.energy;
    }
    const probability = entry => logarithmic ? entry.logT / Math.LN10 : entry.T;
    const curve = result.sweep.map(([x, entry]) => [x, probability(entry)]);
    const markerY = probability(result.selected);
    const low = Math.min(markerY, ...curve.map(point => point[1]));
    const floor = low < -1 ? Math.floor(low) : -1;
    Charts.plot(responseCanvas, {
      xDomain: [result.sweep[0][0], result.sweep.at(-1)[0]],
      yDomain: logarithmic ? [floor, 0] : [0, 1],
      xLabel: "E, эВ", yLabel: logarithmic ? "log₁₀ T" : "T",
      series: [line(curve)],
      guides: [{ axis: "x", value: data.energy, color: colors[2] }],
      marker: { x: data.energy, y: markerY, color: colors[2] },
    });
  }

  function seedTable() {
    if (current().table) return;
    const { width } = current();
    const sign = mode === "well" ? -1 : 1;
    current().table = ["0 " + 0.1 * sign, width / 2 + " " + 0.6 * sign, width + " " + 0.1 * sign].join("\n");
    byId("profile-table").value = current().table;
  }

  for (const button of modeButtons) {
    button.addEventListener("click", () => {
      if (mode === button.dataset.mode) return;
      mode = button.dataset.mode;
      result = undefined;
      byId("well-summary").textContent = "Выполняется расчёт.";
      for (const id of ["transmission", "reflection", "flux-error"]) byId(id).textContent = "—";
      renderControls();
      redraw();
      requestSolve();
    });
  }
  for (const id of ["width", "height", "mass"]) {
    byId(id).addEventListener("input", event => {
      current()[id] = event.target.valueAsNumber;
      renderValues();
      requestSolve();
    });
  }
  function changeEnergy(energy) {
    current().energy = energy;
    renderValues();
    if (result && (energy < result.sweep[0][0] || energy > result.sweep.at(-1)[0])) {
      requestSolve();
    } else if (!result) {
      requestSolve();
    }
    redraw();
  }
  byId("energy").addEventListener("input", event => changeEnergy(event.target.valueAsNumber));
  byId("exact-energy").addEventListener("change", event => {
    if (event.target.checkValidity()) changeEnergy(event.target.valueAsNumber);
    else renderValues();
  });
  byId("exact-mass").addEventListener("change", event => {
    if (event.target.checkValidity()) {
      current().mass = event.target.valueAsNumber;
      requestSolve();
    }
    renderValues();
  });
  byId("shape").addEventListener("change", event => {
    current().shape = event.target.value;
    if (current().shape === "table") seedTable();
    renderShape();
    requestSolve();
  });
  byId("controls").addEventListener("submit", event => {
    event.preventDefault();
    current().formula = byId("formula").value;
    current().table = byId("profile-table").value;
    requestSolve();
  });
  byId("state").addEventListener("change", event => {
    current().selected = Number(event.target.value);
    redraw();
  });
  byId("log-scale").addEventListener("change", redraw);
  byId("reset").addEventListener("click", () => {
    settings[mode] = { ...defaultSettings[mode] };
    result = undefined;
    byId("log-scale").checked = false;
    renderControls();
    redraw();
    requestSolve();
  });
  const resize = new ResizeObserver(redraw);
  resize.observe(potentialCanvas);
  resize.observe(responseCanvas);
  renderControls();
  requestSolve();
})();
