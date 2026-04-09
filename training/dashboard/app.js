const dashboardState = {
	status: null,
	connection: "connecting",
	focus: "all",
	dashboardUrl: null
};

const summaryGrid = document.getElementById("summaryGrid");
const workersGrid = document.getElementById("workersGrid");
const workersHint = document.getElementById("workersHint");
const connectionState = document.getElementById("connectionState");
const dashboardTarget = document.getElementById("dashboardTarget");
const wsLabel = document.getElementById("wsLabel");
const focusAllButton = document.getElementById("focusAll");
const focusBestButton = document.getElementById("focusBest");
const returnsChart = document.getElementById("returnsChart");
const lapChart = document.getElementById("lapChart");
const lapChartTitle = document.getElementById("lapChartTitle");
const lapChartNote = document.getElementById("lapChartNote");
const lossChart = document.getElementById("lossChart");
const entropyChart = document.getElementById("entropyChart");

const summaryFields = [
	["Track", status => status.trackName || "Track"],
	["Workers", status => `${status.connectedWorkers}/${status.targetWorkers}`],
	["Laps", status => `${status.finishedRuns || 0}`],
	["Best Lap", status => Number.isFinite(status.bestLapTime) ? `${Number(status.bestLapTime).toFixed(2)} s` : "-"],
	["Best CP", status => {
		const total = Math.max(Number(status.totalCheckpoints || 0), 0);
		const best = Math.max(Number(status.bestCheckpoint || 0), 0);
		return total > 0 ? `${best}/${total}` : `${best}`;
	}],
	["Steps/s", status => Number(status.stepsPerSecond || 0).toFixed(1)],
	["Rollout", status => `${status.rolloutFill}/${status.rolloutTarget}`],
	["Updates", status => `${status.updates}`],
	["Best Return", status => Number(status.bestEpisodeReturn || 0).toFixed(2)],
	["Mean Return", status => Number(status.meanEpisodeReturn || 0).toFixed(2)],
	["Time Scale", status => `${Number(status.timeScale || 1).toFixed(2)}x`]
];

function getSocketUrl() {
	const url = new URL(window.location.href);
	const explicit = url.searchParams.get("ws");
	if (explicit) return explicit;
	const protocol = "https:" === window.location.protocol ? "wss:" : "ws:";
	const port = window.location.port ? String(Math.max(Number(window.location.port) - 1, 1)) : "8765";
	return `${protocol}//${window.location.hostname}:${port}`;
}

function getInitialFocus() {
	try {
		const url = new URL(window.location.href);
		return "best" === url.searchParams.get("focus") ? "best" : "all";
	} catch (error) {
		return "all";
	}
}

function formatResetReason(reason) {
	return "string" == typeof reason && reason.length > 0 ? reason : "-";
}

function runningMinimum(values) {
	let best = Infinity;
	return values.map((value => {
		best = Math.min(best, value);
		return best;
	}));
}

function setConnectionState(state, label) {
	dashboardState.connection = state;
	connectionState.textContent = label;
	connectionState.className = "state-" + ("connected" === state ? "connected" : "error" === state ? "error" : "muted");
}

function drawLineChart(canvas, series, options = {}) {
	const width = canvas.clientWidth;
	const height = canvas.clientHeight;
	const pixelRatio = window.devicePixelRatio || 1;
	canvas.width = Math.max(1, Math.floor(width * pixelRatio));
	canvas.height = Math.max(1, Math.floor(height * pixelRatio));
	const ctx = canvas.getContext("2d");
	ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
	ctx.clearRect(0, 0, width, height);

	const allValues = series.flatMap(item => item.values).filter(Number.isFinite);
	if (allValues.length === 0) {
		ctx.fillStyle = "rgba(243, 247, 251, 0.56)";
		ctx.font = '16px "Avenir Next", sans-serif';
		ctx.fillText("Waiting for data", 18, height / 2);
		return;
	}

	const minValue = Number.isFinite(options.min) ? options.min : Math.min(...allValues);
	const maxValue = Number.isFinite(options.max) ? options.max : Math.max(...allValues);
	const span = Math.max(maxValue - minValue, 1e-6);
	const padding = { top: 14, right: 16, bottom: 22, left: 16 };
	const chartWidth = Math.max(width - padding.left - padding.right, 1);
	const chartHeight = Math.max(height - padding.top - padding.bottom, 1);

	ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
	ctx.lineWidth = 1;
	for (let row = 0; row < 4; row += 1) {
		const y = padding.top + chartHeight * row / 3;
		ctx.beginPath();
		ctx.moveTo(padding.left, y);
		ctx.lineTo(width - padding.right, y);
		ctx.stroke();
	}

	ctx.fillStyle = "rgba(243, 247, 251, 0.56)";
	ctx.font = '12px "Avenir Next", sans-serif';
	ctx.fillText(maxValue.toFixed(2), padding.left, 12);
	ctx.fillText(minValue.toFixed(2), padding.left, height - 6);

	for (const item of series) {
		const values = item.values.filter(Number.isFinite);
		if (values.length === 0) continue;
		ctx.strokeStyle = item.color;
		ctx.lineWidth = 2;
		ctx.beginPath();
		values.forEach((value, index) => {
			const x = padding.left + chartWidth * (values.length <= 1 ? 0.5 : index / (values.length - 1));
			const y = padding.top + chartHeight * (1 - (value - minValue) / span);
			0 === index ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
		});
		ctx.stroke();
	}
}

function renderSummary(status) {
	summaryGrid.innerHTML = "";
	summaryFields.forEach(([label, resolver]) => {
		const card = document.createElement("article");
		card.className = "summary-card";
		const title = document.createElement("p");
		title.textContent = label;
		const value = document.createElement("strong");
		value.textContent = resolver(status);
		card.appendChild(title);
		card.appendChild(value);
		summaryGrid.appendChild(card);
	});
}

function renderWorkers(status) {
	const workers = Array.isArray(status.workers) ? [...status.workers] : [];
	const bestWorkerId = status.bestWorkerId;
	const missingWorkers = Math.max(Number(status.targetWorkers || 0) - workers.length, 0);
	workersHint.textContent = workers.length > 0 ? `${workers.length} worker${1 === workers.length ? "" : "s"} connected${missingWorkers > 0 ? `, ${missingWorkers} missing` : ""}` : "Waiting for workers";
	workersGrid.innerHTML = "";

	if ("best" === dashboardState.focus && bestWorkerId) {
		const match = workers.find(worker => worker.workerId === bestWorkerId);
		match && workers.splice(0, workers.length, match);
	}

	if (0 === workers.length) return;

	workers.forEach(worker => {
		const card = document.createElement("article");
		card.className = "worker-card" + (worker.workerId === bestWorkerId ? " best" : "");
		const head = document.createElement("div");
		head.className = "worker-head";
		const title = document.createElement("h3");
		title.textContent = worker.workerId;
		const badge = document.createElement("p");
		badge.textContent = worker.workerId === bestWorkerId ? "Best" : `Ep ${worker.episode}`;
		head.appendChild(title);
		head.appendChild(badge);
		card.appendChild(head);

		[
			["Action", worker.action],
			["Checkpoint", `${worker.checkpointIndex}/${worker.totalCheckpoints}`],
			["Episode Return", Number(worker.episodeReturn || 0).toFixed(2)],
			["Best Return", Number(worker.bestReturn || 0).toFixed(2)],
			["Run Time", `${Number(worker.timeSeconds || 0).toFixed(1)} s`],
			["Reset", formatResetReason(worker.lastResetReason)]
		].forEach(([label, value]) => {
			const row = document.createElement("div");
			row.className = "worker-row";
			const left = document.createElement("span");
			left.textContent = label;
			const right = document.createElement("strong");
			right.textContent = value;
			row.appendChild(left);
			row.appendChild(right);
			card.appendChild(row);
		});

		workersGrid.appendChild(card);
	});
}

function renderCharts(status) {
	drawLineChart(returnsChart, [
		{ values: status.episodeHistory || [], color: "#8ce0b6" },
		{ values: status.bestHistory || [], color: "#ffcc72" },
		{ values: status.meanHistory || [], color: "#76b8ff" }
	]);

	const lapTimes = Array.isArray(status.lapTimeHistory) ? status.lapTimeHistory.filter(Number.isFinite) : [];
	if (lapTimes.length > 0) {
		lapChartTitle.textContent = "Lap Times";
		lapChartNote.textContent = `${lapTimes.length} finished run${1 === lapTimes.length ? "" : "s"} | lower is better`;
		drawLineChart(lapChart, [
			{ values: lapTimes, color: "#ffcc72" },
			{ values: runningMinimum(lapTimes), color: "#8ce0b6" }
		], {
			min: 0
		});
	} else {
		const checkpoints = Array.isArray(status.checkpointHistory) ? status.checkpointHistory.filter(Number.isFinite) : [];
		const totalCheckpoints = Math.max(Number(status.totalCheckpoints || 0), 0);
		lapChartTitle.textContent = "Checkpoint Reach";
		lapChartNote.textContent = totalCheckpoints > 0 ? `Episode checkpoint counts until first finish (${totalCheckpoints} total)` : "Episode checkpoint counts until first finish";
		drawLineChart(lapChart, [
			{ values: checkpoints, color: "#76b8ff" }
		], {
			min: 0,
			max: totalCheckpoints > 0 ? totalCheckpoints : void 0
		});
	}

	drawLineChart(lossChart, [
		{ values: status.policyLossHistory || [], color: "#8ce0b6" },
		{ values: status.valueLossHistory || [], color: "#ff9d9d" }
	]);

	drawLineChart(entropyChart, [
		{ values: status.entropyHistory || [], color: "#76b8ff" }
	]);
}

function render() {
	const status = dashboardState.status;
	if (!status) return;
	dashboardTarget.textContent = `${status.trackName || "Track"} | ${status.actionSpace || "bucket9"} | ${Number(status.timeScale || 1).toFixed(2)}x`;
	renderSummary(status);
	renderCharts(status);
	renderWorkers(status);
}

function handleMessage(raw) {
	let message;
	try {
		message = JSON.parse(raw);
	} catch (error) {
		return;
	}
	if (!message || "object" != typeof message) return;
	if ("dashboard_hello" === message.type) {
		dashboardState.dashboardUrl = message.dashboardUrl || null;
	} else if ("dashboard_status" === message.type && message.status) {
		dashboardState.status = message.status;
		if (!dashboardState.focus || "best" !== dashboardState.focus && "all" !== dashboardState.focus) {
			dashboardState.focus = message.status.dashboardFocus || "all";
		}
		render();
	}
}

function connect() {
	const socketUrl = getSocketUrl();
	wsLabel.textContent = socketUrl;
	wsLabel.href = socketUrl;
	try {
		const socket = new WebSocket(socketUrl);
		socket.addEventListener("open", () => {
			setConnectionState("connected", "Connected");
			socket.send(JSON.stringify({ type: "dashboard_hello" }));
		});
		socket.addEventListener("message", event => {
			handleMessage(event.data);
		});
		socket.addEventListener("close", () => {
			setConnectionState("error", "Retrying");
			window.setTimeout(connect, 1200);
		});
		socket.addEventListener("error", () => {
			setConnectionState("error", "Socket Error");
		});
	} catch (error) {
		setConnectionState("error", "Connect Failed");
		window.setTimeout(connect, 1200);
	}
}

function setFocus(focus) {
	dashboardState.focus = focus;
	focusAllButton.classList.toggle("selected", "all" === focus);
	focusBestButton.classList.toggle("selected", "best" === focus);
	render();
}

focusAllButton.addEventListener("click", () => setFocus("all"));
focusBestButton.addEventListener("click", () => setFocus("best"));
window.addEventListener("resize", render);

setFocus(getInitialFocus());
connect();
