const vidvudsTrainingDefaults = Object.freeze({
	serverUrl: "ws://127.0.0.1:8765",
	actionSpace: "bucket9",
	decisionHz: 20,
	sensorPreset: "track1",
	sensorLength: 60,
	sensorOriginHeight: 0.35,
	episodeTimeoutSeconds: 30,
	stallTimeoutSeconds: 6,
	manualFallback: false,
	offTrackStepPenalty: true,
	progressMode: "checkpoint",
	workerCount: 4,
	timeScale: 3,
	dashboardFocus: "best",
	checkpointMode: "fresh",
	trajectoryReference: null
});

const vidvudsTrainingActionSpaces = Object.freeze({
	bucket7: {
		label: "7 buckets"
	},
	bucket9: {
		label: "9 buckets"
	}
});

const vidvudsTrainingSensorPresets = Object.freeze({
	track1: {
		label: "Track 1",
		angles: [-90, -60, -30, -15, 0, 15, 30, 60, 90]
	},
	wide: {
		label: "Wide",
		angles: [-110, -85, -55, -25, 0, 25, 55, 85, 110]
	},
	dense: {
		label: "Dense",
		angles: [-90, -72, -54, -36, -18, 0, 18, 36, 54, 72, 90]
	}
});

const vidvudsTrainingDashboardFocusModes = Object.freeze({
	all: {
		label: "All cars"
	},
	best: {
		label: "Leading car"
	}
});

const vidvudsTrainingCheckpointModes = Object.freeze({
	fresh: {
		label: "Fresh policy"
	},
	resume: {
		label: "Resume checkpoint"
	}
});

const vidvudsTrainingProgressModes = Object.freeze({
	checkpoint: {
		label: "Checkpoint"
	},
	trajectory: {
		label: "Best trajectory"
	}
});

const vidvudsTrainingStoragePrefix = "vidvudsTrainingLaunch:";
const vidvudsTrainingActiveLaunchKey = `${vidvudsTrainingStoragePrefix}active`;
const vidvudsTrainingDebugQueueKey = `${vidvudsTrainingStoragePrefix}debugQueue`;
const vidvudsTrainingActiveLaunchTtlMs = 12e4;
const vidvudsTrainingActiveLaunchHeartbeatMs = 3e3;

const vidvudsTrainingState = {
	panel: null,
	runtime: null,
	pendingLaunch: null,
	lastConfig: null,
	launchRequest: null,
	workerEmbeds: [],
	workerEmbedHost: null,
	dashboardWindow: null,
	autoLaunch: null,
	autoLaunchTriggered: false,
	pageUnloading: false
};

const vidvudsTrainingDebugState = {
	serverUrl: null,
	socket: null,
	queue: [],
	reconnectTimer: null,
	hooksInstalled: false,
	lastMode: null
};

function vidvudsLoadPersistedDebugQueue() {
	try {
		const payload = sessionStorage.getItem(vidvudsTrainingDebugQueueKey);
		if (!payload) return [];
		const parsed = JSON.parse(payload);
		return Array.isArray(parsed) ? parsed.filter((entry => null != entry && "object" == typeof entry)).slice(-200) : [];
	} catch (error) {
		return [];
	}
}

function vidvudsPersistDebugQueue() {
	try {
		0 === vidvudsTrainingDebugState.queue.length ? sessionStorage.removeItem(vidvudsTrainingDebugQueueKey) : sessionStorage.setItem(vidvudsTrainingDebugQueueKey, JSON.stringify(vidvudsTrainingDebugState.queue.slice(-200)));
	} catch (error) {}
}

vidvudsTrainingDebugState.queue = vidvudsLoadPersistedDebugQueue();

function vidvudsDebugSanitize(value, depth = 0) {
	if (depth > 4) return "[depth-limit]";
	if (null == value) return value;
	if ("string" == typeof value || "number" == typeof value || "boolean" == typeof value) return value;
	if (value instanceof Error) return {
		name: value.name,
		message: value.message,
		stack: "string" == typeof value.stack ? value.stack.split("\n").slice(0, 6).join("\n") : null
	};
	if (Array.isArray(value)) return value.slice(0, 24).map((entry => vidvudsDebugSanitize(entry, depth + 1)));
	if ("object" == typeof value) {
		const output = {};
		Object.entries(value).slice(0, 32).forEach((([key, entry]) => {
			output[key] = vidvudsDebugSanitize(entry, depth + 1);
		}));
		return output;
	}
	return String(value);
}

function vidvudsQueueDebugEntry(entry) {
	vidvudsTrainingDebugState.queue.push(entry);
	vidvudsTrainingDebugState.queue.length > 200 && vidvudsTrainingDebugState.queue.splice(0, vidvudsTrainingDebugState.queue.length - 200);
	vidvudsPersistDebugQueue();
}

function vidvudsFlushDebugQueue() {
	const socket = vidvudsTrainingDebugState.socket;
	if (null == socket || socket.readyState !== WebSocket.OPEN) return;
	while (vidvudsTrainingDebugState.queue.length > 0) {
		const entry = vidvudsTrainingDebugState.queue.shift();
		try {
			socket.send(JSON.stringify({
				type: "event",
				event: "browser_debug",
				payload: entry
			}));
		} catch (error) {
			vidvudsTrainingDebugState.queue.unshift(entry);
			vidvudsPersistDebugQueue();
			break;
		}
	}
	vidvudsPersistDebugQueue();
}

function vidvudsScheduleDebugReconnect() {
	if (null != vidvudsTrainingDebugState.reconnectTimer || !"string" == typeof vidvudsTrainingDebugState.serverUrl || vidvudsTrainingDebugState.serverUrl.length <= 0) return;
	vidvudsTrainingDebugState.reconnectTimer = window.setTimeout((() => {
		vidvudsTrainingDebugState.reconnectTimer = null;
		vidvudsEnsureDebugSocket(vidvudsTrainingDebugState.serverUrl);
	}), 1200);
}

function vidvudsEnsureDebugSocket(serverUrl) {
	if (!("string" == typeof serverUrl) || serverUrl.length <= 0) return;
	vidvudsTrainingDebugState.serverUrl = serverUrl;
	const existing = vidvudsTrainingDebugState.socket;
	if (null != existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;
	try {
		const socket = new WebSocket(serverUrl);
		vidvudsTrainingDebugState.socket = socket;
		socket.addEventListener("open", (() => {
			vidvudsFlushDebugQueue();
		}));
		socket.addEventListener("close", (() => {
			vidvudsTrainingDebugState.socket === socket && (vidvudsTrainingDebugState.socket = null);
			vidvudsScheduleDebugReconnect();
		}));
		socket.addEventListener("error", (() => {}));
	} catch (error) {}
}

function vidvudsDebugLog(event, payload = {}) {
	const entry = {
		at: (new Date).toISOString(),
		event,
		payload: vidvudsDebugSanitize(payload),
		href: window.location.href
	};
	try {
		console.log("[vidvuds-training]", event, entry.payload);
	} catch (error) {}
	vidvudsQueueDebugEntry(entry);
	vidvudsFlushDebugQueue();
}

function vidvudsDebugTrackSummary(track) {
	if (null == track || "object" != typeof track) return null;
	return {
		id: null != track.id ? track.id : track.trackId,
		name: null != track.name ? track.name : track.trackName,
		source: null != track.source ? track.source : null,
		external: !0 === track.external,
		hasTrackData: null != track.trackData,
		hasTrackExportString: "string" == typeof track.trackExportString && track.trackExportString.length > 0
	};
}

function vidvudsInstallDebugHooks() {
	if (vidvudsTrainingDebugState.hooksInstalled) return;
	vidvudsTrainingDebugState.hooksInstalled = !0;
	window.addEventListener("error", (event => {
		vidvudsDebugLog("window_error", {
			message: event.message,
			filename: event.filename,
			lineno: event.lineno,
			colno: event.colno,
			error: event.error
		});
	}));
	window.addEventListener("unhandledrejection", (event => {
		vidvudsDebugLog("unhandled_rejection", {
			reason: event.reason
		});
	}));
	window.vidvudsTrainingDebugLog = vidvudsDebugLog;
}

vidvudsInstallDebugHooks();

function vidvudsCreateExternalTrack(track = {}) {
	const exportString = "string" == typeof track.trackExportString && track.trackExportString.trim().length > 0 ? track.trackExportString.trim() : null;
	const id = null != track.trackId ? track.trackId : `session:${Date.now()}-${Math.floor(1e6 * Math.random())}`;
	return {
		id,
		name: "string" == typeof track.trackName && track.trackName.trim().length > 0 ? track.trackName.trim() : "Editor Draft",
		trackData: null != track.trackData ? track.trackData : null,
		trackExportString: exportString,
		external: !0,
		source: "string" == typeof track.source ? track.source : "session"
	};
}

function vidvudsClamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function vidvudsMinimumTimeScale(decisionHz) {
	const hz = Math.max(Number(decisionHz) || vidvudsTrainingDefaults.decisionHz, 1);
	return vidvudsClamp(1 / hz, .25, 1);
}

function vidvudsPushSample(samples, value, limit = 90) {
	samples.push(value);
	samples.length > limit && samples.splice(0, samples.length - limit);
}

function vidvudsEstimateRate(samples) {
	if (!Array.isArray(samples) || samples.length < 2) return 0;
	const elapsed = Number(samples[samples.length - 1]) - Number(samples[0]);
	return elapsed > 1e-6 ? (samples.length - 1) / elapsed : 0;
}

function vidvudsStoreLaunchRequest(request) {
	try {
		localStorage.setItem(`${vidvudsTrainingStoragePrefix}${request.launchKey}`, JSON.stringify(request));
	} catch (error) {}
	return request;
}

function vidvudsSetActiveLaunchRequest(request, updatedAt = Date.now()) {
	if (null == request || "object" != typeof request || "string" != typeof request.launchKey || request.launchKey.length <= 0) return null;
	vidvudsStoreLaunchRequest(request);
	const marker = {
		launchKey: request.launchKey,
		updatedAt
	};
	try {
		localStorage.setItem(vidvudsTrainingActiveLaunchKey, JSON.stringify(marker));
	} catch (error) {}
	return marker;
}

function vidvudsTouchActiveLaunchRequest(launchKey, updatedAt = Date.now()) {
	if ("string" != typeof launchKey || launchKey.length <= 0) return null;
	const marker = {
		launchKey,
		updatedAt
	};
	try {
		localStorage.setItem(vidvudsTrainingActiveLaunchKey, JSON.stringify(marker));
	} catch (error) {}
	return marker;
}

function vidvudsClearActiveLaunchRequest() {
	try {
		localStorage.removeItem(vidvudsTrainingActiveLaunchKey);
	} catch (error) {}
}

function vidvudsGetActiveLaunchRequest() {
	let marker;
	try {
		marker = JSON.parse(localStorage.getItem(vidvudsTrainingActiveLaunchKey) || "null");
	} catch (error) {
		vidvudsClearActiveLaunchRequest();
		return null;
	}
	if (null == marker || "object" != typeof marker || "string" != typeof marker.launchKey || marker.launchKey.length <= 0) {
		vidvudsClearActiveLaunchRequest();
		return null;
	}
	if (!Number.isFinite(marker.updatedAt) || Date.now() - marker.updatedAt > vidvudsTrainingActiveLaunchTtlMs) {
		vidvudsClearActiveLaunchRequest();
		return null;
	}
	try {
		const payload = localStorage.getItem(`${vidvudsTrainingStoragePrefix}${marker.launchKey}`);
		if (!payload) return vidvudsClearActiveLaunchRequest(), null;
		const parsed = JSON.parse(payload);
		if (null == parsed || "object" != typeof parsed || parsed.launchKey !== marker.launchKey) return vidvudsClearActiveLaunchRequest(), null;
		return parsed;
	} catch (error) {
		vidvudsClearActiveLaunchRequest();
		return null;
	}
}

function vidvudsNormalizeTrajectoryReference(reference) {
	if (null == reference || "object" != typeof reference) return null;
	const points = Array.isArray(reference.points) ? reference.points.map((point => {
		if (null == point || "object" != typeof point) return null;
		const x = Number(point.x);
		const y = Number(point.y);
		const z = Number(point.z);
		const progress = Number(point.progress);
		if (![x, y, z, progress].every(Number.isFinite)) return null;
		return {
			x,
			y,
			z,
			progress: Math.max(progress, 0)
		};
	})).filter((point => null != point)) : [];
	if (points.length < 2) return null;
	return {
		trackId: null != reference.trackId ? reference.trackId : null,
		timeSeconds: Number.isFinite(reference.timeSeconds) ? Number(reference.timeSeconds) : null,
		sampleFrames: Math.max(Math.floor(Number(reference.sampleFrames) || 0), 1),
		points
	};
}

function vidvudsNormalizeTrainingConfig(config = {}) {
	config = null != config && "object" == typeof config ? config : {};
	const actionSpace = config.actionSpace in vidvudsTrainingActionSpaces ? config.actionSpace : vidvudsTrainingDefaults.actionSpace;
	const sensorPreset = config.sensorPreset in vidvudsTrainingSensorPresets ? config.sensorPreset : vidvudsTrainingDefaults.sensorPreset;
	const checkpointMode = config.checkpointMode in vidvudsTrainingCheckpointModes ? config.checkpointMode : vidvudsTrainingDefaults.checkpointMode;
	const progressMode = config.progressMode in vidvudsTrainingProgressModes ? config.progressMode : vidvudsTrainingDefaults.progressMode;
	const serverUrl = "string" == typeof config.serverUrl && /\S/.test(config.serverUrl) ? config.serverUrl.trim() : vidvudsTrainingDefaults.serverUrl;
	const trackName = "string" == typeof config.trackName ? config.trackName : "";
	const decisionHz = vidvudsClamp(Number.isFinite(config.decisionHz) ? config.decisionHz : vidvudsTrainingDefaults.decisionHz, 5, 100);
	const minimumTimeScale = vidvudsMinimumTimeScale(decisionHz);
	const trajectoryReference = "trajectory" === progressMode ? vidvudsNormalizeTrajectoryReference(config.trajectoryReference) : null;
	return {
		serverUrl,
		actionSpace,
		decisionHz,
		sensorPreset,
			sensorLength: vidvudsClamp(Number.isFinite(config.sensorLength) ? config.sensorLength : vidvudsTrainingDefaults.sensorLength, 20, 160),
			sensorOriginHeight: vidvudsClamp(Number.isFinite(config.sensorOriginHeight) ? config.sensorOriginHeight : vidvudsTrainingDefaults.sensorOriginHeight, 0.05, 1.2),
			episodeTimeoutSeconds: vidvudsClamp(Number.isFinite(config.episodeTimeoutSeconds) ? config.episodeTimeoutSeconds : vidvudsTrainingDefaults.episodeTimeoutSeconds, 10, 180),
			stallTimeoutSeconds: vidvudsClamp(Number.isFinite(config.stallTimeoutSeconds) ? config.stallTimeoutSeconds : vidvudsTrainingDefaults.stallTimeoutSeconds, 0, 30),
			manualFallback: !0 === config.manualFallback,
			offTrackStepPenalty: !1 !== config.offTrackStepPenalty,
			progressMode: null != trajectoryReference ? progressMode : "checkpoint",
			workerCount: vidvudsClamp(Number.isFinite(config.workerCount) ? config.workerCount : vidvudsTrainingDefaults.workerCount, 1, 48),
			timeScale: vidvudsClamp(Number.isFinite(config.timeScale) ? config.timeScale : vidvudsTrainingDefaults.timeScale, minimumTimeScale, 64),
			dashboardFocus: config.dashboardFocus in vidvudsTrainingDashboardFocusModes ? config.dashboardFocus : vidvudsTrainingDefaults.dashboardFocus,
			checkpointMode,
			trajectoryReference,
		trackName,
		trackId: null != config.trackId ? config.trackId : null,
		workerMode: "string" == typeof config.workerMode ? config.workerMode : "primary",
		launchKey: "string" == typeof config.launchKey ? config.launchKey : null,
		blockedWorkers: Math.max(Number(config.blockedWorkers) || 0, 0)
	};
}

function vidvudsCreateSensorConfig(config) {
	const preset = vidvudsTrainingSensorPresets[config.sensorPreset] || vidvudsTrainingSensorPresets.track1;
	return {
		sensorAnglesDegrees: [...preset.angles],
		sensorLength: config.sensorLength,
		sensorOriginHeight: config.sensorOriginHeight
	};
}

function vidvudsCreateElement(tagName, className = "", textContent = null) {
	const element = document.createElement(tagName);
	className && (element.className = className);
	null != textContent && (element.textContent = textContent);
	return element;
}

function vidvudsNormalizeControls(controls = {}) {
	return {
		up: !0 === controls.up,
		right: !0 === controls.right,
		down: !0 === controls.down,
		left: !0 === controls.left
	};
}

function vidvudsCompactDetector(detector) {
	if (null == detector || "object" != typeof detector || null == detector.center || "object" != typeof detector.center) return null;
	return {
		rotation: Number(detector.rotation) || 0,
		center: {
			x: Number(detector.center.x) || 0,
			y: Number(detector.center.y) || 0,
			z: Number(detector.center.z) || 0
		},
		size: {
			x: Number(detector.size && detector.size.x) || 0,
			y: Number(detector.size && detector.size.y) || 0,
			z: Number(detector.size && detector.size.z) || 0
		}
	};
}

function vidvudsCompactTrainingState(state) {
	if (null == state || "object" != typeof state) return state;
	return {
		active: !0 === state.active,
		mode: "string" == typeof state.mode ? state.mode : "play",
		trackId: null != state.trackId ? state.trackId : null,
		frame: Number(state.frame) || 0,
		started: !0 === state.started,
		finished: !0 === state.finished,
		timeSeconds: Number(state.timeSeconds) || 0,
		checkpointIndex: Number(state.checkpointIndex) || 0,
		totalCheckpoints: Number(state.totalCheckpoints) || 0,
		position: {
			x: Number(state.position && state.position.x) || 0,
			y: Number(state.position && state.position.y) || 0,
			z: Number(state.position && state.position.z) || 0
		},
		quaternion: {
			x: Number(state.quaternion && state.quaternion.x) || 0,
			y: Number(state.quaternion && state.quaternion.y) || 0,
			z: Number(state.quaternion && state.quaternion.z) || 0,
			w: Number(state.quaternion && state.quaternion.w) || 1
		},
		linearVelocity: {
			x: Number(state.linearVelocity && state.linearVelocity.x) || 0,
			y: Number(state.linearVelocity && state.linearVelocity.y) || 0,
			z: Number(state.linearVelocity && state.linearVelocity.z) || 0
		},
		speedKmh: Number(state.speedKmh) || 0,
		heightAboveGround: Number(state.heightAboveGround) || 0,
		distanceToCurrentCheckpoint: Number.isFinite(state.distanceToCurrentCheckpoint) ? Number(state.distanceToCurrentCheckpoint) : null,
		distanceToFinish: Number.isFinite(state.distanceToFinish) ? Number(state.distanceToFinish) : null,
		wheelState: Array.isArray(state.wheelState) ? state.wheelState.slice(0, 4).map((wheel => ({
			inContact: !0 === (wheel && wheel.inContact),
			skidInfo: Number(wheel && wheel.skidInfo) || 0
		}))) : [],
		collisionImpulses: Array.isArray(state.collisionImpulses) ? state.collisionImpulses.slice(0, 12).map((impulse => Number(impulse) || 0)) : [],
		nextCheckpointDetectors: Array.isArray(state.nextCheckpointDetectors) ? state.nextCheckpointDetectors.map(vidvudsCompactDetector).filter(Boolean) : [],
		finishDetectors: Array.isArray(state.finishDetectors) ? state.finishDetectors.map(vidvudsCompactDetector).filter(Boolean) : [],
		sensors: Array.isArray(state.sensors) ? state.sensors.map((sensor => ({
			normalizedDistance: Number.isFinite(sensor && sensor.normalizedDistance) ? Number(sensor.normalizedDistance) : 1
		}))) : []
	};
}

function vidvudsCompactClusterMapState(state) {
	if (null == state || "object" != typeof state) return null;
	return {
		trackId: null != state.trackId ? state.trackId : null,
		started: !0 === state.started,
		finished: !0 === state.finished,
		timeSeconds: Number(state.timeSeconds) || 0,
		checkpointIndex: Number(state.checkpointIndex) || 0,
		totalCheckpoints: Number(state.totalCheckpoints) || 0,
		distanceToCurrentCheckpoint: Number.isFinite(state.distanceToCurrentCheckpoint) ? Number(state.distanceToCurrentCheckpoint) : null,
		speedKmh: Number(state.speedKmh) || 0,
		position: {
			x: Number(state.position && state.position.x) || 0,
			y: Number(state.position && state.position.y) || 0,
			z: Number(state.position && state.position.z) || 0
		},
		quaternion: {
			x: Number(state.quaternion && state.quaternion.x) || 0,
			y: Number(state.quaternion && state.quaternion.y) || 0,
			z: Number(state.quaternion && state.quaternion.z) || 0,
			w: Number(state.quaternion && state.quaternion.w) || 1
		},
		forward: {
			x: Number(state.forward && state.forward.x) || 0,
			y: Number(state.forward && state.forward.y) || 0,
			z: Number(state.forward && state.forward.z) || 1
		}
	};
}

function vidvudsHashString(value = "") {
	let hash = 2166136261;
	const text = String(value);
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function vidvudsClusterWorkerPalette(workerId, isBest) {
	if (isBest) return {
		primary: "#ffd86d",
		secondary: "#fff0b1",
		frame: "#f7f2dd",
		rims: "#ffffff"
	};
	const hue = vidvudsHashString(workerId) % 360;
	return {
		primary: `hsl(${hue}, 82%, 58%)`,
		secondary: `hsl(${(hue + 18) % 360}, 58%, 32%)`,
		frame: `hsl(${(hue + 194) % 360}, 18%, 78%)`,
		rims: `hsl(${(hue + 194) % 360}, 10%, 92%)`
	};
}

function vidvudsTrainingOffsetPoint(point, quaternion, localOffset) {
	const worldOffset = vidvudsTrainingRotateVector(localOffset, quaternion || {
		x: 0,
		y: 0,
		z: 0,
		w: 1
	});
	return {
		x: (Number(point && point.x) || 0) + worldOffset.x,
		y: (Number(point && point.y) || 0) + worldOffset.y,
		z: (Number(point && point.z) || 0) + worldOffset.z
	};
}

function vidvudsCreateClusterPlaceholderCars(existingWorkerIds, targetWorkers, track) {
	const totalWorkers = Math.max(Number(targetWorkers) || 1, 1);
	const missingRemoteWorkers = Math.max(totalWorkers - 1 - existingWorkerIds.size, 0);
	if (missingRemoteWorkers <= 0 || null == track || null == track.start || null == track.start.position) return [];
	const startPosition = track.start.position;
	const startQuaternion = track.start.quaternion || {
		x: 0,
		y: 0,
		z: 0,
		w: 1
	};
	const placeholders = [];
	const columns = 3;
	const lateralSpacing = 2.9;
	const longitudinalSpacing = 5.2;
	for (let index = 0; index < missingRemoteWorkers; index++) {
		const slot = existingWorkerIds.size + index;
		const column = slot % columns;
		const row = Math.floor(slot / columns);
		const centeredColumn = column - .5 * (Math.min(columns, missingRemoteWorkers) - 1);
		const workerId = `pending-worker-${slot + 2}`;
		placeholders.push({
			workerId,
			position: vidvudsTrainingOffsetPoint(startPosition, startQuaternion, {
				x: centeredColumn * lateralSpacing,
				y: 0,
				z: -1.5 - row * longitudinalSpacing
			}),
			quaternion: {
				x: Number(startQuaternion.x) || 0,
				y: Number(startQuaternion.y) || 0,
				z: Number(startQuaternion.z) || 0,
				w: Number(startQuaternion.w) || 1
			},
			forward: {
				x: 0,
				y: 0,
				z: 1
			},
			opacity: 0.18,
			colors: {
				primary: "#5a6f83",
				secondary: "#263646",
				frame: "#94a6b4",
				rims: "#c7d2da"
			},
			isBest: !1
		});
	}
	return placeholders;
}

function vidvudsCreateClusterScenePayload(clusterWorkers, bestWorkerId, track, targetWorkers) {
	if (!(clusterWorkers instanceof Map)) return [];
	const remoteWorkers = Array.from(clusterWorkers.values()).filter((worker => {
		return worker && !worker.isLocal && null != worker.liveState && null != worker.liveState.position;
	}));
	const payload = remoteWorkers.map(((worker, index) => {
		const isBest = worker.workerId === bestWorkerId;
		return {
			workerId: worker.workerId,
			position: {
				x: Number(worker.liveState.position && worker.liveState.position.x) || 0,
				y: Number(worker.liveState.position && worker.liveState.position.y) || 0,
				z: Number(worker.liveState.position && worker.liveState.position.z) || 0
			},
			quaternion: {
				x: Number(worker.liveState.quaternion && worker.liveState.quaternion.x) || 0,
				y: Number(worker.liveState.quaternion && worker.liveState.quaternion.y) || 0,
				z: Number(worker.liveState.quaternion && worker.liveState.quaternion.z) || 0,
				w: Number(worker.liveState.quaternion && worker.liveState.quaternion.w) || 1
			},
			forward: {
				x: Number(worker.liveState.forward && worker.liveState.forward.x) || 0,
				y: Number(worker.liveState.forward && worker.liveState.forward.y) || 0,
				z: Number(worker.liveState.forward && worker.liveState.forward.z) || 1
			},
			opacity: isBest ? 0.72 : Math.max(0.28, 0.48 - 0.01 * Math.min(index, 16)),
			colors: vidvudsClusterWorkerPalette(worker.workerId, isBest),
			isBest
		};
	}));
	const existingWorkerIds = new Set(remoteWorkers.map((worker => worker.workerId)));
	return payload.concat(vidvudsCreateClusterPlaceholderCars(existingWorkerIds, targetWorkers, track));
}

function vidvudsTrainingAverageDetectorCenter(detectors) {
	if (!Array.isArray(detectors) || 0 === detectors.length) return null;
	const points = detectors.map((detector => detector && detector.center)).filter((center => null != center && "object" == typeof center));
	if (0 === points.length) return null;
	const scale = 1 / points.length;
	return {
		x: points.reduce(((sum, center) => sum + (Number(center.x) || 0)), 0) * scale,
		y: points.reduce(((sum, center) => sum + (Number(center.y) || 0)), 0) * scale,
		z: points.reduce(((sum, center) => sum + (Number(center.z) || 0)), 0) * scale
	};
}

function vidvudsTrainingInverseQuaternion(quaternion) {
	return {
		x: -(Number(quaternion && quaternion.x) || 0),
		y: -(Number(quaternion && quaternion.y) || 0),
		z: -(Number(quaternion && quaternion.z) || 0),
		w: Number(quaternion && quaternion.w) || 1
	};
}

function vidvudsTrainingRotateVector(vector, quaternion) {
	const vx = Number(vector && vector.x) || 0;
	const vy = Number(vector && vector.y) || 0;
	const vz = Number(vector && vector.z) || 0;
	const qx = Number(quaternion && quaternion.x) || 0;
	const qy = Number(quaternion && quaternion.y) || 0;
	const qz = Number(quaternion && quaternion.z) || 0;
	const qw = Number(quaternion && quaternion.w) || 1;
	const ix = qw * vx + qy * vz - qz * vy;
	const iy = qw * vy + qz * vx - qx * vz;
	const iz = qw * vz + qx * vy - qy * vx;
	const iw = -qx * vx - qy * vy - qz * vz;
	return {
		x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
		y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
		z: iz * qw + iw * -qz + ix * -qy - iy * -qx
	};
}

function vidvudsTrainingFeaturePreview(state) {
	if (null == state || "object" != typeof state) return null;
	const inverseQuaternion = vidvudsTrainingInverseQuaternion(state.quaternion);
	const localVelocity = vidvudsTrainingRotateVector(state.linearVelocity, inverseQuaternion);
	const position = state.position || {
		x: 0,
		y: 0,
		z: 0
	};
	let target = vidvudsTrainingAverageDetectorCenter(state.nextCheckpointDetectors);
	null == target && (target = vidvudsTrainingAverageDetectorCenter(state.finishDetectors));
	let localTarget = {
		x: 0,
		y: 0,
		z: 0
	};
	if (null != target) {
		localTarget = vidvudsTrainingRotateVector({
			x: (Number(target.x) || 0) - (Number(position.x) || 0),
			y: (Number(target.y) || 0) - (Number(position.y) || 0),
			z: (Number(target.z) || 0) - (Number(position.z) || 0)
		}, inverseQuaternion);
	}
	const detectors = Array.isArray(state.nextCheckpointDetectors) && state.nextCheckpointDetectors.length > 0 ? state.nextCheckpointDetectors : Array.isArray(state.finishDetectors) ? state.finishDetectors : [];
	const nearestDetector = detectors.reduce(((closest, detector) => {
		if (null == detector || null == detector.center) return closest;
		const dx = (Number(detector.center.x) || 0) - (Number(position.x) || 0);
		const dz = (Number(detector.center.z) || 0) - (Number(position.z) || 0);
		const distanceSq = dx * dx + dz * dz;
		return null == closest || distanceSq < closest.distanceSq ? {
			detector,
			distanceSq
		} : closest;
	}), null);
	let laneOffset = 0;
	let gateAlignment = 0;
	if (null != nearestDetector) {
		const detector = nearestDetector.detector;
		const widthUsesX = Math.abs(Number(detector.size && detector.size.x) || 0) >= Math.abs(Number(detector.size && detector.size.z) || 0);
		const halfWidth = Math.max(.5 * Math.abs(widthUsesX ? Number(detector.size && detector.size.x) || 0 : Number(detector.size && detector.size.z) || 0), 1);
		laneOffset = ((widthUsesX ? Number(position.x) - Number(detector.center.x) : Number(position.z) - Number(detector.center.z)) || 0) / halfWidth;
		const forward = vidvudsTrainingRotateVector({
			x: 0,
			y: 0,
			z: 1
		}, state.quaternion || {});
		gateAlignment = Math.abs(widthUsesX ? forward.z : forward.x);
	}
	const wheelState = Array.isArray(state.wheelState) ? state.wheelState.slice(0, 4) : [];
	return {
		sensors: Array.isArray(state.sensors) ? state.sensors.map((sensor => Number.isFinite(sensor && sensor.normalizedDistance) ? Number(sensor.normalizedDistance) : 1)) : [],
		wheelContacts: wheelState.map((wheel => !!(wheel && wheel.inContact))),
		wheelSkid: wheelState.map((wheel => Number(wheel && wheel.skidInfo) || 0)),
		localVelocity,
		localTarget,
		laneOffset,
		gateAlignment,
		speedKmh: Number(state.speedKmh) || 0,
		heightAboveGround: Number(state.heightAboveGround) || 0,
		checkpointDistance: Number.isFinite(state.distanceToCurrentCheckpoint) ? Number(state.distanceToCurrentCheckpoint) : null,
		finishDistance: Number.isFinite(state.distanceToFinish) ? Number(state.distanceToFinish) : null
	};
}

function vidvudsSafeTrainingApi() {
	return null != window.vidvudsTraining ? window.vidvudsTraining : null;
}

function vidvudsSafeGetMode() {
	try {
		const api = vidvudsSafeTrainingApi();
		return null != api && "function" == typeof api.getMode ? api.getMode() : null;
	} catch (error) {
		return null;
	}
}

function vidvudsSafeGetState() {
	try {
		const api = vidvudsSafeTrainingApi();
		return null != api && "function" == typeof api.getState ? api.getState() : null;
	} catch (error) {
		return null;
	}
}

function vidvudsSafeGetTrackData() {
	try {
		const api = vidvudsSafeTrainingApi();
		return null != api && "function" == typeof api.getTrackData ? api.getTrackData() : null;
	} catch (error) {
		return null;
	}
}

function vidvudsTrainingTrackReference(track) {
	if (null == track || "object" != typeof track) return null;
	return {
		trackId: null != track.id ? track.id : null,
		trackData: null != track.trackData ? track.trackData : null,
		trackExportString: "string" == typeof track.trackExportString ? track.trackExportString : null
	};
}

function vidvudsGetTrajectoryRecordInfo(track) {
	try {
		const api = vidvudsSafeTrainingApi();
		return null != api && "function" == typeof api.getBestRecordInfo ? api.getBestRecordInfo(vidvudsTrainingTrackReference(track)) : null;
	} catch (error) {
		return null;
	}
}

function vidvudsBuildTrajectoryReference(track) {
	try {
		const api = vidvudsSafeTrainingApi();
		if (null == api || "function" != typeof api.buildTrajectoryReference) return null;
		return vidvudsNormalizeTrajectoryReference(api.buildTrajectoryReference(vidvudsTrainingTrackReference(track), {
			sampleFrames: 10,
			maxPoints: 4096
		}));
	} catch (error) {
		return null;
	}
}

function vidvudsSafePlayClick(audio) {
	try {
		null != audio && "function" == typeof audio.playUIClick && audio.playUIClick();
	} catch (error) {}
}

function vidvudsIsEmbeddedTrainingWorker() {
	try {
		const url = new URL(window.location.href);
		return "1" === url.searchParams.get("vidvudsTrainingEmbed") || window.self !== window.top;
	} catch (error) {
		return window.self !== window.top;
	}
}

function vidvudsDeriveDashboardUrl(serverUrl, focus = "best") {
	try {
		const trainerUrl = new URL(serverUrl);
		const protocol = "wss:" === trainerUrl.protocol ? "https:" : "http:";
		const port = trainerUrl.port ? String(Math.max(Number(trainerUrl.port) + 1, 1)) : "8766";
		const dashboardUrl = new URL(`${protocol}//${trainerUrl.hostname}:${port}/training/dashboard/index.html`);
		dashboardUrl.searchParams.set("ws", serverUrl);
		dashboardUrl.searchParams.set("focus", focus);
		return dashboardUrl.toString();
	} catch (error) {
		return `http://127.0.0.1:8766/training/dashboard/index.html?ws=${encodeURIComponent(serverUrl)}&focus=${encodeURIComponent(focus)}`;
	}
}

function vidvudsOpenDashboardWindow(config) {
	const dashboardUrl = vidvudsDeriveDashboardUrl(config.serverUrl, config.dashboardFocus);
	try {
		vidvudsTrainingState.dashboardWindow = window.open(dashboardUrl, "polytrack-training-dashboard");
	} catch (error) {}
	return dashboardUrl;
}

function vidvudsCreateLaunchRequest(config, track) {
	const normalized = vidvudsNormalizeTrainingConfig(config);
	const launchKey = `${Date.now()}-${Math.floor(1e6 * Math.random())}`;
	return vidvudsStoreLaunchRequest({
		launchKey,
		createdAt: Date.now(),
		trackId: track.id,
		trackName: track.name,
		trackExportString: "string" == typeof track.trackExportString ? track.trackExportString : null,
		config: {
			...normalized,
			trackId: track.id,
			trackName: track.name,
			launchKey
		}
	});
}

function vidvudsGetAutoLaunchRequest() {
	if (null != vidvudsTrainingState.autoLaunch) return vidvudsTrainingState.autoLaunch;
	const embeddedWindow = vidvudsIsEmbeddedTrainingWorker();
	let url;
	try {
		url = new URL(window.location.href);
	} catch (error) {
		if (!embeddedWindow) return null;
		const activeLaunch = vidvudsGetActiveLaunchRequest();
		null != activeLaunch && (vidvudsTrainingState.autoLaunch = activeLaunch);
		return activeLaunch;
	}
	const launchKey = url.searchParams.get("vidvudsTrainingLaunch");
	if (!launchKey) {
		if (!embeddedWindow) return null;
		const activeLaunch = vidvudsGetActiveLaunchRequest();
		null != activeLaunch && (vidvudsTrainingState.autoLaunch = activeLaunch);
		return activeLaunch;
	}
	try {
		const payload = localStorage.getItem(`${vidvudsTrainingStoragePrefix}${launchKey}`);
		if (!payload) return null;
		const parsed = JSON.parse(payload);
		if (null == parsed || "object" != typeof parsed || parsed.launchKey !== launchKey) return null;
		if (Number.isFinite(parsed.createdAt) && Date.now() - parsed.createdAt > 36e5) return null;
		vidvudsTrainingState.autoLaunch = parsed;
		return parsed;
	} catch (error) {
		return null;
	}
}

function vidvudsStripAutoLaunchParams() {
	try {
		const url = new URL(window.location.href);
		url.searchParams.delete("vidvudsTrainingLaunch");
		url.searchParams.delete("vidvudsTrainingWorker");
		window.history.replaceState(null, "", url.toString());
	} catch (error) {}
}

function vidvudsBuildWorkerUrl(launchKey, workerIndex) {
	const url = new URL(window.location.href);
	url.searchParams.set("vidvudsTrainingLaunch", launchKey);
	url.searchParams.set("vidvudsTrainingWorker", String(workerIndex));
	return url.toString();
}

function vidvudsEnsureWorkerEmbedHost() {
	if (null != vidvudsTrainingState.workerEmbedHost && document.body.contains(vidvudsTrainingState.workerEmbedHost)) return vidvudsTrainingState.workerEmbedHost;
	const host = vidvudsCreateElement("div", "training-worker-embeds");
	host.setAttribute("aria-hidden", "true");
	document.body.appendChild(host);
	vidvudsTrainingState.workerEmbedHost = host;
	return host;
}

function vidvudsClearWorkerEmbeds() {
	vidvudsTrainingState.workerEmbeds.forEach((frame => {
		try {
			null != frame && null != frame.parentNode && frame.parentNode.removeChild(frame);
		} catch (error) {}
	}));
	vidvudsTrainingState.workerEmbeds = [];
	if (null != vidvudsTrainingState.workerEmbedHost && 0 === vidvudsTrainingState.workerEmbedHost.childElementCount) {
		try {
			null != vidvudsTrainingState.workerEmbedHost.parentNode && vidvudsTrainingState.workerEmbedHost.parentNode.removeChild(vidvudsTrainingState.workerEmbedHost);
		} catch (error) {}
		vidvudsTrainingState.workerEmbedHost = null;
	}
}

function vidvudsLaunchEmbeddedWorkers(request) {
	vidvudsClearWorkerEmbeds();
	const host = vidvudsEnsureWorkerEmbedHost();
	const requestedWorkers = Math.max(Number(request && request.config && request.config.workerCount) || 1, 1);
	for (let index = 1; index < requestedWorkers; index++) {
		try {
			const frame = vidvudsCreateElement("iframe", "training-worker-embed");
			frame.title = `polytrack-training-worker-${index}`;
			frame.setAttribute("loading", "eager");
			frame.setAttribute("referrerpolicy", "same-origin");
			frame.src = vidvudsBuildWorkerUrl(request.launchKey, index);
			host.appendChild(frame);
			vidvudsTrainingState.workerEmbeds.push(frame);
		} catch (error) {}
	}
	const launchedWorkers = vidvudsTrainingState.workerEmbeds.length + 1;
	request.config.workerCount = requestedWorkers;
	request.config.blockedWorkers = Math.max(requestedWorkers - launchedWorkers, 0);
	vidvudsStoreLaunchRequest(request);
	return launchedWorkers;
}

function vidvudsFindTrackById(panel, trackId) {
	return panel.sessionTracks.concat(panel.standardTracks, panel.customTracks).find((track => track.id === trackId)) || null;
}

function vidvudsTryAutoLaunchIntoTrainingMenu() {
	const launchRequest = vidvudsGetAutoLaunchRequest();
	if (null == launchRequest || vidvudsTrainingState.autoLaunchTriggered) return;
	if ("menu" !== vidvudsSafeGetMode()) return;
	const buttons = Array.from(document.querySelectorAll(".menu button > p"));
	const trainingLabel = buttons.find((node => "Training" === node.textContent));
	if (null == trainingLabel || null == trainingLabel.parentElement) return;
	vidvudsTrainingState.autoLaunchTriggered = !0;
	vidvudsDebugLog("auto_launch_click_training", {
		launchKey: launchRequest.launchKey,
		trackId: launchRequest.trackId,
		trackName: launchRequest.trackName
	});
	vidvudsStripAutoLaunchParams();
	trainingLabel.parentElement.click();
}

class VidvudsTrainingMenuPanel {
	constructor(options) {
		this.options = options;
		this.locale = options.locale;
		this.audio = options.audio;
		this.trackCollection = options.trackCollection;
		this.startPlay = options.startPlay;
		this.startExportTrack = options.startExportTrack;
		this.onClose = options.onClose;
		this.autoLaunch = options.autoLaunch;
		this.autoLaunchRetryTimer = null;
		this.autoLaunchAttemptCount = 0;
		this.config = vidvudsNormalizeTrainingConfig(options.initialConfig);
		this.selectedTrack = null;
		this.disposed = false;
		this.root = vidvudsCreateElement("div", "settings-menu training-mode-menu");
		this.container = vidvudsCreateElement("div", "container");
		this.handleKeyDown = event => {
			"Escape" == event.code && this.cancel();
		};
		this.collectTracks();
		this.applyAutoLaunchSelection();
		this.render();
		options.parent.appendChild(this.root);
		window.addEventListener("keydown", this.handleKeyDown);
		if (null != this.autoLaunch) {
			this.scheduleAutoLaunchStart(0);
		}
	}

	scheduleAutoLaunchStart(delayMs = 250) {
		if (null == this.autoLaunch || this.disposed) return;
		null != this.autoLaunchRetryTimer && clearTimeout(this.autoLaunchRetryTimer);
		this.autoLaunchRetryTimer = window.setTimeout((() => {
			this.autoLaunchRetryTimer = null;
			this.tryAutoLaunchStart();
		}), Math.max(Number(delayMs) || 0, 0));
	}

	tryAutoLaunchStart() {
		if (null == this.autoLaunch || this.disposed) return;
		this.autoLaunchAttemptCount += 1;
		this.collectTracks();
		this.applyAutoLaunchSelection();
		this.render();
		const started = this.start({
			spawnWorkers: !1,
			openDashboard: !1,
			workerMode: vidvudsIsEmbeddedTrainingWorker() ? "embedded" : "popup"
		});
		if (!started && this.autoLaunchAttemptCount < 80) {
			this.scheduleAutoLaunchStart(250);
		}
	}

	collectTracks() {
		this.sessionTracks = Array.isArray(this.options.extraTracks) ? this.options.extraTracks.map((track => vidvudsCreateExternalTrack(track))).filter((track => null != track)) : [];
		this.standardTracks = [];
		this.customTracks = [];
		try {
			null != this.trackCollection && "function" == typeof this.trackCollection.refreshCustomTracks && this.trackCollection.refreshCustomTracks();
			null != this.trackCollection && "function" == typeof this.trackCollection.forEachStandard && this.trackCollection.forEachStandard(((id, name, trackData) => {
				this.standardTracks.push({
					id,
					name,
					trackData
				});
			}));
			null != this.trackCollection && "function" == typeof this.trackCollection.forEachCustom && this.trackCollection.forEachCustom(((id, name, trackData) => {
				this.customTracks.push({
					id,
					name,
					trackData
				});
			}));
		} catch (error) {
			console.error(error);
		}
		const allTracks = this.sessionTracks.concat(this.standardTracks, this.customTracks);
		if (allTracks.length > 0) {
			if (null != this.config.trackId) {
				const exactMatch = allTracks.find((track => track.id === this.config.trackId));
				null != exactMatch && (this.selectedTrack = exactMatch);
			}
			null == this.selectedTrack && (this.selectedTrack = allTracks[0], this.config.trackId = this.selectedTrack.id, this.config.trackName = this.selectedTrack.name);
		}
	}

	applyAutoLaunchSelection() {
		if (null == this.autoLaunch) return;
		let match = vidvudsFindTrackById(this, this.autoLaunch.trackId);
		null == match && "string" == typeof this.autoLaunch.trackExportString && this.autoLaunch.trackExportString.length > 0 && (match = vidvudsCreateExternalTrack({
			trackId: null != this.autoLaunch.trackId ? this.autoLaunch.trackId : null,
			trackName: this.autoLaunch.trackName,
			trackExportString: this.autoLaunch.trackExportString,
			source: "launch"
		}), this.sessionTracks.unshift(match));
		null != match && (this.selectedTrack = match);
		this.config = vidvudsNormalizeTrainingConfig(this.autoLaunch.config);
		null != this.selectedTrack && (this.config.trackId = this.selectedTrack.id, this.config.trackName = this.selectedTrack.name);
	}

	getTrajectoryRecordInfo() {
		return "trajectory" === this.config.progressMode && null != this.selectedTrack ? vidvudsGetTrajectoryRecordInfo(this.selectedTrack) : null;
	}

	buildLaunchConfig() {
		const nextConfig = {
			...this.config,
			trackId: null != this.selectedTrack ? this.selectedTrack.id : this.config.trackId,
			trackName: null != this.selectedTrack ? this.selectedTrack.name : this.config.trackName,
			trajectoryReference: null
		};
		if ("trajectory" !== nextConfig.progressMode) return nextConfig;
		const recordInfo = this.getTrajectoryRecordInfo();
		if (!(null != recordInfo && !0 === recordInfo.hasRecord)) return null;
		const trajectoryReference = vidvudsBuildTrajectoryReference(this.selectedTrack);
		if (null == trajectoryReference) return null;
		nextConfig.trajectoryReference = trajectoryReference;
		null != trajectoryReference.trackId && (nextConfig.trackId = trajectoryReference.trackId);
		return nextConfig;
	}

	cancel() {
		this.dispose();
		"function" == typeof this.onClose && this.onClose();
	}

	start(options = {}) {
		if (null == this.selectedTrack) return !1;
		const launchConfig = this.buildLaunchConfig();
		if (null == launchConfig) {
			window.alert("Trajectory progress needs a completed time on this track first.");
			return !1;
		}
		const launchMetadata = {
			id: this.selectedTrack.id,
			name: this.selectedTrack.name
		};
		const canStartTrack = null != this.selectedTrack.trackData && "function" == typeof this.startPlay || "string" == typeof this.selectedTrack.trackExportString && "function" == typeof this.startExportTrack;
		if (!canStartTrack) return !1;
		const spawnWorkers = !1 !== options.spawnWorkers;
		const openDashboard = !1 !== options.openDashboard;
		this.config = {
			...launchConfig,
			workerMode: "string" == typeof options.workerMode ? options.workerMode : "primary"
		};
		vidvudsTrainingState.lastConfig = vidvudsNormalizeTrainingConfig(this.config);
		vidvudsEnsureDebugSocket(vidvudsTrainingState.lastConfig.serverUrl);
		vidvudsDebugLog("training_start_requested", {
			track: vidvudsDebugTrackSummary(this.selectedTrack),
			config: vidvudsTrainingState.lastConfig,
			spawnWorkers,
			openDashboard
		});
		if (spawnWorkers) {
			vidvudsTrainingState.launchRequest = vidvudsCreateLaunchRequest(vidvudsTrainingState.lastConfig, this.selectedTrack);
			vidvudsTrainingState.lastConfig = vidvudsNormalizeTrainingConfig(vidvudsTrainingState.launchRequest.config);
			vidvudsTrainingState.pendingLaunch = {
				...vidvudsTrainingState.lastConfig,
				workerCount: Math.max(Number(vidvudsTrainingState.launchRequest.config.workerCount) || 1, 1),
				blockedWorkers: 0,
				workerMode: "primary",
				launchKey: vidvudsTrainingState.launchRequest.launchKey
			};
			openDashboard && vidvudsOpenDashboardWindow(vidvudsTrainingState.launchRequest.config);
		} else vidvudsTrainingState.pendingLaunch = {
			...vidvudsTrainingState.lastConfig,
			workerCount: null != this.config.launchKey ? Math.max(Number(this.config.workerCount) || 1, 1) : 1,
			blockedWorkers: null != this.config.launchKey ? Math.max(Number(this.config.blockedWorkers) || 0, 0) : 0,
			workerMode: this.config.workerMode,
			launchKey: this.config.launchKey
		};
		const launchMode = null != this.selectedTrack.trackData ? "track_data" : "track_export";
		try {
			this.dispose();
			null != this.selectedTrack.trackData && "function" == typeof this.startPlay ? this.startPlay(this.selectedTrack.trackData, launchMetadata) : "string" == typeof this.selectedTrack.trackExportString && "function" == typeof this.startExportTrack && this.startExportTrack(this.selectedTrack.trackExportString, launchMetadata);
			vidvudsDebugLog("training_start_invoked", {
				launchMode,
				track: vidvudsDebugTrackSummary(this.selectedTrack),
				pendingLaunch: vidvudsTrainingState.pendingLaunch
			});
			return !0;
		} catch (error) {
			vidvudsDebugLog("training_start_threw", {
				launchMode,
				track: vidvudsDebugTrackSummary(this.selectedTrack),
				error
			});
			throw error;
		}
	}

	addButtonRow(buttonWrapper, value, title, selected, onSelect, extraClass = "") {
		const button = vidvudsCreateElement("button", `button${selected ? " selected" : ""}${extraClass ? " " + extraClass : ""}`, title);
		button.addEventListener("click", (() => {
			vidvudsSafePlayClick(this.audio);
			onSelect(value);
			this.render();
		}));
		buttonWrapper.appendChild(button);
	}

	addChoiceSetting(parent, label, currentValue, options, onSelect, wrappable = !1, buttonClass = "") {
		const row = vidvudsCreateElement("div", wrappable ? "setting wrappable" : "setting");
		row.appendChild(vidvudsCreateElement("p", "", label));
		const wrapper = vidvudsCreateElement("div", "button-wrapper");
		options.forEach((option => {
			this.addButtonRow(wrapper, option.value, option.title, currentValue === option.value, onSelect, buttonClass);
		}));
		row.appendChild(wrapper);
		parent.appendChild(row);
	}

	addRangeSetting(parent, label, key, min, max, step, formatter) {
		const row = vidvudsCreateElement("div", "setting");
		const value = vidvudsClamp(Number(this.config[key]), min, max);
		const title = vidvudsCreateElement("p", "", "");
		const updateValue = value => {
			const numericValue = vidvudsClamp(Number(value), min, max);
			this.config[key] = numericValue;
			if ("decisionHz" === key) {
				this.config.timeScale = Math.max(Number(this.config.timeScale) || 1, vidvudsMinimumTimeScale(numericValue));
			}
			title.textContent = `${label}: ${formatter(numericValue)}`;
			return numericValue;
		};
		updateValue(value);
		row.appendChild(title);
		const input = vidvudsCreateElement("input");
		input.type = "range";
		input.min = String(min);
		input.max = String(max);
		input.step = String(step);
		input.value = String(value);
		input.addEventListener("input", (() => {
			updateValue(input.value);
		}));
		input.addEventListener("change", (() => {
			const numericValue = updateValue(input.value);
			input.value = String(numericValue);
			this.render();
		}));
		row.appendChild(input);
		parent.appendChild(row);
	}

	addTextSetting(parent, label, value, onChange) {
		const row = vidvudsCreateElement("div", "setting");
		row.appendChild(vidvudsCreateElement("p", "", label));
		const input = vidvudsCreateElement("input");
		input.type = "text";
		input.value = value;
		input.addEventListener("change", (() => {
			onChange(input.value);
		}));
		input.addEventListener("blur", (() => {
			onChange(input.value);
			this.render();
		}));
		row.appendChild(input);
		parent.appendChild(row);
	}

	addTrackSection(parent) {
		parent.appendChild(vidvudsCreateElement("h2", "", "Track"));
		const selectedName = null != this.selectedTrack ? this.selectedTrack.name : "Tracks are still loading";
		const selectedRow = vidvudsCreateElement("div", "setting");
		selectedRow.appendChild(vidvudsCreateElement("p", "", `Selected: ${selectedName}`));
		parent.appendChild(selectedRow);
		if (this.sessionTracks.length > 0) {
			this.addChoiceSetting(parent, "Session", null != this.selectedTrack ? this.selectedTrack.id : null, this.sessionTracks.map((track => ({
				title: track.name,
				value: track.id
			}))), (trackId => {
				const match = this.sessionTracks.find((track => track.id === trackId));
				null != match && (this.selectedTrack = match);
			}), !0, "track-button");
		}
		if (this.standardTracks.length > 0) {
			this.addChoiceSetting(parent, "Standard", null != this.selectedTrack ? this.selectedTrack.id : null, this.standardTracks.map((track => ({
				title: track.name,
				value: track.id
			}))), (trackId => {
				const match = this.standardTracks.find((track => track.id === trackId));
				null != match && (this.selectedTrack = match);
			}), !0, "track-button");
		}
		if (this.customTracks.length > 0) {
			this.addChoiceSetting(parent, "Custom", null != this.selectedTrack ? this.selectedTrack.id : null, this.customTracks.map((track => ({
				title: track.name,
				value: track.id
			}))), (trackId => {
				const match = this.customTracks.find((track => track.id === trackId));
				null != match && (this.selectedTrack = match);
			}), !0, "track-button");
		}
	}

	render() {
		const previousRootScrollTop = this.root.scrollTop;
		const previousContainerScrollTop = this.container.scrollTop;
		this.root.innerHTML = "";
		this.root.appendChild(vidvudsCreateElement("h2", "", "Training"));
		this.container.innerHTML = "";
		const note = vidvudsCreateElement("div", "training-note");
		note.innerHTML = 'Start the Python trainer first with <code>python -m training</code>. Multi-worker training keeps your live car in the main view, shows worker cars directly on the track, and caps live sim speed by render FPS so the requested decision rate stays stable.';
		this.container.appendChild(note);
		this.addTrackSection(this.container);
		this.container.appendChild(vidvudsCreateElement("h2", "", "Controls"));
		this.addChoiceSetting(this.container, "Action space", this.config.actionSpace, Object.entries(vidvudsTrainingActionSpaces).map((([value, config]) => ({
			title: config.label,
			value
		}))), (value => {
			this.config.actionSpace = value;
		}));
		this.addRangeSetting(this.container, "Decision rate", "decisionHz", 5, 100, 1, (value => `${Math.round(value)} Hz`));
		this.addChoiceSetting(this.container, "Manual takeover", this.config.manualFallback, [{
			title: "Off",
			value: !1
		}, {
			title: "On",
			value: !0
			}], (value => {
				this.config.manualFallback = !!value;
			}));
		this.addChoiceSetting(this.container, "Off-track step penalty", this.config.offTrackStepPenalty, [{
			title: "Off",
			value: !1
		}, {
			title: "On",
			value: !0
		}], (value => {
			this.config.offTrackStepPenalty = !!value;
		}));
		this.addChoiceSetting(this.container, "Progress tracking", this.config.progressMode, Object.entries(vidvudsTrainingProgressModes).map((([value, config]) => ({
			title: config.label,
			value
		}))), (value => {
			this.config.progressMode = value;
			"trajectory" !== value && (this.config.trajectoryReference = null);
		}));
		const trajectoryRecordInfo = this.getTrajectoryRecordInfo();
		if ("trajectory" === this.config.progressMode) {
			const trajectoryRow = vidvudsCreateElement("div", "setting");
			trajectoryRow.appendChild(vidvudsCreateElement("p", "", "Best run"));
			const description = null != trajectoryRecordInfo && !0 === trajectoryRecordInfo.hasRecord ? `Using ${Number(trajectoryRecordInfo.timeSeconds || 0).toFixed(2)} s as the reference line.` : "No saved time on this track yet. Set a time first to use trajectory progress.";
			trajectoryRow.appendChild(vidvudsCreateElement("p", "", description));
			this.container.appendChild(trajectoryRow);
		}
		this.container.appendChild(vidvudsCreateElement("h2", "", "Sensors"));
		this.addChoiceSetting(this.container, "Sensor preset", this.config.sensorPreset, Object.entries(vidvudsTrainingSensorPresets).map((([value, config]) => ({
			title: config.label,
			value
		}))), (value => {
			this.config.sensorPreset = value;
		}));
		this.addRangeSetting(this.container, "Sensor length", "sensorLength", 20, 140, 1, (value => `${Math.round(value)} m`));
		this.addRangeSetting(this.container, "Sensor height", "sensorOriginHeight", 0.05, 1.2, 0.01, (value => value.toFixed(2)));
		this.container.appendChild(vidvudsCreateElement("h2", "", "Workers"));
		this.addRangeSetting(this.container, "Workers", "workerCount", 1, 48, 1, (value => `${Math.round(value)}`));
		this.addRangeSetting(this.container, "Sim speed", "timeScale", vidvudsMinimumTimeScale(this.config.decisionHz), 64, 0.05, (value => `${Number(value).toFixed(2)}x`));
		this.container.appendChild(vidvudsCreateElement("h2", "", "Trainer"));
		this.addTextSetting(this.container, "Trainer URL", this.config.serverUrl, (value => {
			this.config.serverUrl = "string" == typeof value && /\S/.test(value) ? value.trim() : vidvudsTrainingDefaults.serverUrl;
		}));
		const dashboardRow = vidvudsCreateElement("div", "setting");
		dashboardRow.appendChild(vidvudsCreateElement("p", "", "Dashboard"));
		const dashboardButton = vidvudsCreateElement("button", "button", "Open Dashboard");
		dashboardButton.addEventListener("click", (() => {
			vidvudsSafePlayClick(this.audio);
			vidvudsOpenDashboardWindow(this.config);
		}));
		dashboardRow.appendChild(dashboardButton);
		this.container.appendChild(dashboardRow);
		this.addRangeSetting(this.container, "Episode timeout", "episodeTimeoutSeconds", 10, 120, 1, (value => `${Math.round(value)} s`));
		this.addRangeSetting(this.container, "Stall timeout", "stallTimeoutSeconds", 0, 30, 0.5, (value => value <= 0 ? "Off" : `${Number(value).toFixed(value < 10 && Math.abs(value - Math.round(value)) > 1e-6 ? 1 : 0)} s`));
		this.root.appendChild(this.container);
		const buttonWrapper = vidvudsCreateElement("div", "button-wrapper");
		const cancelButton = vidvudsCreateElement("button", "button cancel", null != this.locale && "function" == typeof this.locale.get ? this.locale.get("Cancel") : "Cancel");
		cancelButton.addEventListener("click", (() => {
			vidvudsSafePlayClick(this.audio);
			this.cancel();
		}));
		buttonWrapper.appendChild(cancelButton);
		const clusterButton = vidvudsCreateElement("button", "button start-training", "Start Training");
		clusterButton.classList.add("start-training");
		const requiresTrajectoryRecord = "trajectory" === this.config.progressMode && !(null != trajectoryRecordInfo && !0 === trajectoryRecordInfo.hasRecord);
		clusterButton.disabled = null == this.selectedTrack || requiresTrajectoryRecord;
		clusterButton.addEventListener("click", (() => {
			vidvudsSafePlayClick(this.audio);
			this.start({
				spawnWorkers: !0,
				openDashboard: !1
			});
		}));
		buttonWrapper.appendChild(clusterButton);
		const visibleButton = vidvudsCreateElement("button", "button", "Start Single View");
		visibleButton.disabled = null == this.selectedTrack || requiresTrajectoryRecord;
		visibleButton.addEventListener("click", (() => {
			vidvudsSafePlayClick(this.audio);
			this.start({
				spawnWorkers: !1,
				openDashboard: !1,
				workerMode: "primary"
			});
		}));
		buttonWrapper.appendChild(visibleButton);
		this.root.appendChild(buttonWrapper);
		this.root.scrollTop = previousRootScrollTop;
		this.container.scrollTop = previousContainerScrollTop;
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = !0;
		null != this.autoLaunchRetryTimer && clearTimeout(this.autoLaunchRetryTimer);
		this.autoLaunchRetryTimer = null;
		window.removeEventListener("keydown", this.handleKeyDown);
		null != this.root.parentNode && this.root.parentNode.removeChild(this.root);
	}
}

class VidvudsTrainingVisionPanel {
	constructor() {
		this.disposed = !1;
		this.root = vidvudsCreateElement("div", "training-vision");
		const header = vidvudsCreateElement("div", "header");
		header.appendChild(vidvudsCreateElement("h2", "", "AI Vision"));
		const closeButton = vidvudsCreateElement("button", "button", "Hide");
		closeButton.addEventListener("click", (() => {
			null != window.vidvudsTrainingMode && "function" == typeof window.vidvudsTrainingMode.toggleVision && window.vidvudsTrainingMode.toggleVision(!1);
		}));
		header.appendChild(closeButton);
		this.root.appendChild(header);
		const note = vidvudsCreateElement("p", "hint", "Drive manually and compare what the policy sees: sensor fan, target vector, wheel contacts, and local velocity.");
		this.root.appendChild(note);
		this.canvas = vidvudsCreateElement("canvas", "vision-canvas");
		this.canvas.width = 420;
		this.canvas.height = 220;
		this.root.appendChild(this.canvas);
		this.readout = vidvudsCreateElement("div", "vision-readout");
		this.readoutNodes = new Map;
		["Speed", "Ground", "Target", "Velocity", "Lane", "Wheels", "Checkpoint"].forEach((label => {
			const metric = vidvudsCreateElement("div", "metric");
			metric.appendChild(vidvudsCreateElement("p", "", label));
			const value = vidvudsCreateElement("strong", "", "-");
			metric.appendChild(value);
			this.readout.appendChild(metric);
			this.readoutNodes.set(label, value);
		}));
		this.root.appendChild(this.readout);
		document.getElementById("ui").appendChild(this.root);
	}

	update(state, sensorConfig) {
		if (this.disposed) return;
		const context = this.canvas.getContext("2d");
		if (null == context) return;
		const width = this.canvas.width;
		const height = this.canvas.height;
		context.clearRect(0, 0, width, height);
		context.fillStyle = "rgba(8, 14, 24, 0.96)";
		context.fillRect(0, 0, width, height);
		context.strokeStyle = "rgba(255, 255, 255, 0.08)";
		context.lineWidth = 1;
		for (let index = 1; index <= 4; index++) {
			const y = height - 24 - 40 * index;
			context.beginPath();
			context.moveTo(18, y);
			context.lineTo(width - 18, y);
			context.stroke();
		}
		const centerX = width / 2;
		const originY = height - 28;
		const preview = vidvudsTrainingFeaturePreview(state);
		if (null == preview) {
			this.readoutNodes.forEach((node => {
				node.textContent = "-";
			}));
			return;
		}
		const stateAngles = Array.isArray(state && state.sensors) && state.sensors.length === preview.sensors.length ? state.sensors.map((sensor => Number.isFinite(sensor && sensor.angleDegrees) ? Number(sensor.angleDegrees) : null)) : [];
		const angles = stateAngles.length === preview.sensors.length && stateAngles.every((value => Number.isFinite(value))) ? stateAngles : Array.isArray(sensorConfig && sensorConfig.sensorAnglesDegrees) && sensorConfig.sensorAnglesDegrees.length === preview.sensors.length ? sensorConfig.sensorAnglesDegrees : preview.sensors.map(((value, index, list) => -90 + 180 * index / Math.max(list.length - 1, 1)));
		const maxRadius = 132;
		context.fillStyle = "rgba(255, 255, 255, 0.56)";
		context.font = '12px "Avenir Next", sans-serif';
		context.fillText("L", 20, originY - 6);
		context.fillText("R", width - 28, originY - 6);
		preview.sensors.forEach(((distance, index) => {
			// Training physics uses local +X as car-left, so mirror to screen space.
			const angle = -(Number(angles[index]) || 0) * Math.PI / 180;
			const radius = maxRadius * (0.2 + .8 * vidvudsClamp(distance, 0, 1));
			const hitRadius = maxRadius * vidvudsClamp(distance, 0, 1);
			const targetX = centerX + Math.sin(angle) * radius;
			const targetY = originY - Math.cos(angle) * radius;
			const hitX = centerX + Math.sin(angle) * hitRadius;
			const hitY = originY - Math.cos(angle) * hitRadius;
			context.strokeStyle = distance < .3 ? "#ff8d8d" : distance < .6 ? "#ffd86d" : "rgba(126, 240, 164, 0.88)";
			context.lineWidth = 2;
			context.beginPath();
			context.moveTo(centerX, originY);
			context.lineTo(targetX, targetY);
			context.stroke();
			context.fillStyle = context.strokeStyle;
			context.beginPath();
			context.arc(hitX, hitY, 4, 0, 2 * Math.PI);
			context.fill();
		}));
		const targetScale = 54;
		const targetX = centerX - vidvudsClamp(preview.localTarget.x / 120, -1.4, 1.4) * targetScale;
		const targetY = originY - vidvudsClamp(preview.localTarget.z / 120, -1.4, 1.4) * targetScale;
		context.strokeStyle = "#7ef0a4";
		context.lineWidth = 3;
		context.beginPath();
		context.moveTo(centerX, originY);
		context.lineTo(targetX, targetY);
		context.stroke();
		context.fillStyle = "#7ef0a4";
		context.beginPath();
		context.arc(targetX, targetY, 5, 0, 2 * Math.PI);
		context.fill();
		context.fillStyle = "#ffffff";
		context.beginPath();
		context.moveTo(centerX, originY - 18);
		context.lineTo(centerX - 12, originY + 10);
		context.lineTo(centerX + 12, originY + 10);
		context.closePath();
		context.fill();
		preview.wheelContacts.forEach(((contact, index) => {
			const x = 18 + index * 28;
			const y = 18;
			context.fillStyle = contact ? "#7ef0a4" : "rgba(255,255,255,0.12)";
			context.fillRect(x, y, 18, 18);
		}));
		this.readoutNodes.get("Speed").textContent = `${preview.speedKmh.toFixed(1)} km/h`;
		this.readoutNodes.get("Ground").textContent = `${preview.heightAboveGround.toFixed(2)} m`;
		this.readoutNodes.get("Target").textContent = `${preview.localTarget.x.toFixed(1)}, ${preview.localTarget.y.toFixed(1)}, ${preview.localTarget.z.toFixed(1)}`;
		this.readoutNodes.get("Velocity").textContent = `${preview.localVelocity.x.toFixed(1)}, ${preview.localVelocity.y.toFixed(1)}, ${preview.localVelocity.z.toFixed(1)}`;
		this.readoutNodes.get("Lane").textContent = `off ${preview.laneOffset.toFixed(2)} | align ${(100 * preview.gateAlignment).toFixed(0)}%`;
		this.readoutNodes.get("Wheels").textContent = preview.wheelContacts.map((contact => contact ? "1" : "0")).join(" ");
		this.readoutNodes.get("Checkpoint").textContent = `${null != preview.checkpointDistance ? preview.checkpointDistance.toFixed(1) + " m" : "-"} | ${null != preview.finishDistance ? preview.finishDistance.toFixed(1) + " m finish" : "finish -"}`;
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = !0;
		null != this.root.parentNode && this.root.parentNode.removeChild(this.root);
	}
}

class VidvudsTrainingClusterPanel {
	constructor() {
		this.disposed = !1;
		this.root = vidvudsCreateElement("div", "training-cluster");
		const header = vidvudsCreateElement("div", "header");
		header.appendChild(vidvudsCreateElement("h2", "", "Cluster Map"));
		header.appendChild(vidvudsCreateElement("p", "cluster-state", "Live"));
		this.root.appendChild(header);
		this.root.appendChild(vidvudsCreateElement("p", "hint", "All active workers share this top-down map. Best run gets the outline, and overlapping cars fade instead of hiding each other."));
		this.canvas = vidvudsCreateElement("canvas", "cluster-canvas");
		this.canvas.width = 420;
		this.canvas.height = 248;
		this.root.appendChild(this.canvas);
		this.readout = vidvudsCreateElement("div", "cluster-readout");
		this.readoutNodes = new Map;
		["Workers", "Leader", "Checkpoint", "Speed"].forEach((label => {
			const metric = vidvudsCreateElement("div", "metric");
			metric.appendChild(vidvudsCreateElement("p", "", label));
			const value = vidvudsCreateElement("strong", "", "-");
			metric.appendChild(value);
			this.readout.appendChild(metric);
			this.readoutNodes.set(label, value);
		}));
		this.root.appendChild(this.readout);
		document.getElementById("ui").appendChild(this.root);
	}

	orderedCheckpointCenters(track) {
		if (null == track || !Array.isArray(track.checkpoints)) return [];
		const grouped = new Map;
		track.checkpoints.forEach((detector => {
			if (null == detector || "object" != typeof detector) return;
			const key = Number.isFinite(detector.checkpointOrder) ? Number(detector.checkpointOrder) : grouped.size;
			const bucket = grouped.get(key) || [];
			bucket.push(detector);
			grouped.set(key, bucket);
		}));
		return Array.from(grouped.entries()).sort(((left, right) => left[0] - right[0])).map((entry => vidvudsTrainingAverageDetectorCenter(entry[1]))).filter(Boolean);
	}

	resolveBounds(track, workers) {
		let minX = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let minZ = Number.POSITIVE_INFINITY;
		let maxZ = Number.NEGATIVE_INFINITY;
		const includePoint = point => {
			if (null == point || "object" != typeof point) return;
			const x = Number(point.x);
			const z = Number(point.z);
			if (!Number.isFinite(x) || !Number.isFinite(z)) return;
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minZ = Math.min(minZ, z);
			maxZ = Math.max(maxZ, z);
		};
		if (null != track && null != track.boundsParts && null != track.boundsParts.min && null != track.boundsParts.max) {
			includePoint(track.boundsParts.min);
			includePoint(track.boundsParts.max);
		}
		if (null != track && Array.isArray(track.checkpoints)) {
			track.checkpoints.forEach((detector => {
				includePoint(detector && detector.center);
			}));
		}
		if (null != track && Array.isArray(track.finishDetectors)) {
			track.finishDetectors.forEach((detector => {
				includePoint(detector && detector.center);
			}));
		}
		workers.forEach((worker => {
			includePoint(worker && worker.liveState && worker.liveState.position);
		}));
		if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
			return {
				minX: -40,
				maxX: 40,
				minZ: -40,
				maxZ: 40
			};
		}
		const spanX = Math.max(maxX - minX, 30);
		const spanZ = Math.max(maxZ - minZ, 30);
		const padding = Math.max(Math.max(spanX, spanZ) * 0.08, 12);
		return {
			minX: minX - padding,
			maxX: maxX + padding,
			minZ: minZ - padding,
			maxZ: maxZ + padding
		};
	}

	createProjector(bounds, width, height, padding = 18) {
		const spanX = Math.max(bounds.maxX - bounds.minX, 1);
		const spanZ = Math.max(bounds.maxZ - bounds.minZ, 1);
		const scale = Math.min((width - 2 * padding) / spanX, (height - 2 * padding) / spanZ);
		const usedWidth = spanX * scale;
		const usedHeight = spanZ * scale;
		const offsetX = (width - usedWidth) / 2;
		const offsetY = (height - usedHeight) / 2;
		return {
			scale,
			project: point => ({
				x: offsetX + (Number(point && point.x) - bounds.minX) * scale,
				y: height - (offsetY + (Number(point && point.z) - bounds.minZ) * scale)
			})
		};
	}

	drawDetector(context, projector, detector, fillStyle, strokeStyle) {
		if (null == detector || null == detector.center || null == detector.size) return;
		const center = projector.project(detector.center);
		const width = Math.max(Math.abs(Number(detector.size.x) || 0) * projector.scale, 2);
		const height = Math.max(Math.abs(Number(detector.size.z) || 0) * projector.scale, 2);
		context.fillStyle = fillStyle;
		context.fillRect(center.x - width / 2, center.y - height / 2, width, height);
		context.strokeStyle = strokeStyle;
		context.lineWidth = 1;
		context.strokeRect(center.x - width / 2, center.y - height / 2, width, height);
	}

	drawWorker(context, point, angle, color, alpha, highlight) {
		const size = highlight ? 8 : 6;
		context.save();
		context.translate(point.x, point.y);
		context.rotate(angle);
		if (highlight) {
			context.strokeStyle = "rgba(255, 216, 109, 0.95)";
			context.lineWidth = 2;
			context.beginPath();
			context.arc(0, 0, size + 4, 0, 2 * Math.PI);
			context.stroke();
		}
		context.globalAlpha = alpha;
		context.fillStyle = color;
		context.beginPath();
		context.moveTo(0, -size - 1);
		context.lineTo(size * 0.9, size + 1);
		context.lineTo(-size * 0.9, size + 1);
		context.closePath();
		context.fill();
		context.restore();
	}

	update(payload = {}) {
		if (this.disposed) return;
		const context = this.canvas.getContext("2d");
		if (null == context) return;
		const width = this.canvas.width;
		const height = this.canvas.height;
		const track = null != payload.track && "object" == typeof payload.track ? payload.track : null;
		const workers = Array.isArray(payload.workers) ? payload.workers.filter((worker => null != worker && null != worker.liveState && null != worker.liveState.position)) : [];
		const connectedWorkers = Math.max(Number(payload.connectedWorkers) || workers.length, workers.length);
		const targetWorkers = Math.max(Number(payload.targetWorkers) || connectedWorkers || 1, 1);
		const bestWorkerId = "string" == typeof payload.bestWorkerId ? payload.bestWorkerId : null;
		context.clearRect(0, 0, width, height);
		context.fillStyle = "rgba(8, 14, 24, 0.96)";
		context.fillRect(0, 0, width, height);
		if (null == track) {
			context.fillStyle = "rgba(243, 247, 251, 0.56)";
			context.font = '16px "Avenir Next", sans-serif';
			context.fillText("Waiting for track data", 18, height / 2);
			this.readoutNodes.get("Workers").textContent = `${workers.length}/${targetWorkers}`;
			this.readoutNodes.get("Leader").textContent = bestWorkerId || "-";
			this.readoutNodes.get("Checkpoint").textContent = "-";
			this.readoutNodes.get("Speed").textContent = "-";
			return;
		}
		const projector = this.createProjector(this.resolveBounds(track, workers), width, height, 20);
		context.strokeStyle = "rgba(255, 255, 255, 0.06)";
		context.lineWidth = 1;
		for (let index = 1; index <= 3; index++) {
			const x = width * index / 4;
			const y = height * index / 4;
			context.beginPath();
			context.moveTo(x, 10);
			context.lineTo(x, height - 10);
			context.stroke();
			context.beginPath();
			context.moveTo(10, y);
			context.lineTo(width - 10, y);
			context.stroke();
		}
		if (Array.isArray(track.checkpoints)) {
			track.checkpoints.forEach((detector => {
				this.drawDetector(context, projector, detector, "rgba(118, 184, 255, 0.10)", "rgba(118, 184, 255, 0.34)");
			}));
		}
		if (Array.isArray(track.finishDetectors)) {
			track.finishDetectors.forEach((detector => {
				this.drawDetector(context, projector, detector, "rgba(255, 216, 109, 0.12)", "rgba(255, 216, 109, 0.42)");
			}));
		}
		const route = this.orderedCheckpointCenters(track);
		if (route.length > 1) {
			context.strokeStyle = "rgba(126, 240, 164, 0.28)";
			context.lineWidth = 3;
			context.beginPath();
			route.forEach(((center, index) => {
				const point = projector.project(center);
				0 === index ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y);
			}));
			context.stroke();
		}
		const overlapBuckets = new Map;
		const projectedWorkers = workers.map((worker => {
			const point = projector.project(worker.liveState.position);
			const forward = null != worker.liveState.forward ? worker.liveState.forward : {
				x: 0,
				z: 1
			};
			const nose = projector.project({
				x: Number(worker.liveState.position.x) + 3 * (Number(forward.x) || 0),
				z: Number(worker.liveState.position.z) + 3 * (Number(forward.z) || 1)
			});
			const bucketKey = `${Math.round(point.x / 8)}|${Math.round(point.y / 8)}`;
			overlapBuckets.set(bucketKey, (overlapBuckets.get(bucketKey) || 0) + 1);
			return {
				...worker,
				point,
				angle: Math.atan2(nose.y - point.y, nose.x - point.x) + Math.PI / 2,
				bucketKey
			};
		}));
		projectedWorkers.forEach((worker => {
			const overlapCount = overlapBuckets.get(worker.bucketKey) || 1;
			const highlight = worker.workerId === bestWorkerId;
			const alpha = highlight ? 0.98 : vidvudsClamp(0.92 / Math.sqrt(overlapCount), 0.22, 0.86);
			const color = highlight ? "#ffd86d" : worker.isLocal ? "#7ef0a4" : worker.liveState.finished ? "#8ce0b6" : "#76b8ff";
			this.drawWorker(context, worker.point, worker.angle, color, alpha, highlight);
		}));
		const leader = projectedWorkers.find((worker => worker.workerId === bestWorkerId)) || projectedWorkers[0] || null;
		this.readoutNodes.get("Workers").textContent = `${connectedWorkers}/${targetWorkers}`;
		this.readoutNodes.get("Leader").textContent = null != leader ? leader.workerId : bestWorkerId || "-";
		this.readoutNodes.get("Checkpoint").textContent = null != leader ? `${Number(leader.liveState.checkpointIndex) || 0}/${Math.max(Number(leader.liveState.totalCheckpoints) || 0, 0)}` : "-";
		this.readoutNodes.get("Speed").textContent = null != leader ? `${Number(leader.liveState.speedKmh || 0).toFixed(1)} km/h` : "-";
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = !0;
		null != this.root.parentNode && this.root.parentNode.removeChild(this.root);
	}
}

class VidvudsTrainingEnvWorkerClient {
	constructor(runtime, envKey, slotIndex) {
		this.runtime = runtime;
		this.envKey = envKey;
		this.slotIndex = slotIndex;
		this.sessionId = `${runtime.sessionId}:${envKey}:${Math.floor(1e6 * Math.random())}`;
		this.disposed = false;
		this.latestControls = vidvudsNormalizeControls();
		this.lastState = null;
		this.resetPending = !1;
		this.resetSequence = 0;
		this.lastResetReason = "startup";
		this.status = {
			workerId: "-",
			action: "idle",
			episode: 0,
			episodeStep: 0,
			episodeReturn: 0,
			bestReturn: 0,
			checkpointIndex: 0,
			totalCheckpoints: 0,
			lastResetReason: "startup"
		};
		this.lastClusterKey = this.clusterKey();
	}

	episodeTimedOut(state = this.lastState) {
		const timeoutSeconds = Number(this.runtime && this.runtime.config ? this.runtime.config.episodeTimeoutSeconds : 0);
		if (!(timeoutSeconds > 0) || this.resetPending || null == state || !state.active || !0 !== state.started) return !1;
		return Number(state.timeSeconds) >= timeoutSeconds;
	}

	clusterKey() {
		return "string" == typeof this.status.workerId && "-" !== this.status.workerId ? this.status.workerId : this.envKey;
	}

	connect(forceReconnect = !1) {
		return !this.disposed;
	}

	send(message) {
		return message;
	}

	sendHello(track, state) {
		return null != track && null != state && !!state.active;
	}

	handleMessage(raw) {
		return raw;
	}

	applyServerControl(message) {
		if (null == message || "object" != typeof message) return;
		if ("string" == typeof message.workerId && message.workerId.length > 0) {
			this.status.workerId = message.workerId;
		}
		if ("hello" === message.type) {
			this.status.workerId = "string" == typeof message.workerId ? message.workerId : this.status.workerId;
		} else if ("control" === message.type) {
			this.latestControls = vidvudsNormalizeControls(message.controls);
			message.reset ? this.requestReset(message.reason) : this.resetPending = !1;
			null != message.status && this.mergeStatus(message.status);
		} else if ("status" === message.type) {
			null != message.status && this.mergeStatus(message.status);
		}
	}

	requestReset(reason) {
		this.lastResetReason = "string" == typeof reason && reason.length > 0 ? reason : "server";
		this.status.lastResetReason = this.lastResetReason;
		this.resetPending = !0;
		this.resetSequence += 1;
	}

	mergeStatus(status) {
		for (const [key, value] of Object.entries(status)) this.status[key] = value;
	}

	appliedControls(state = null) {
		if (null == state || (!0 !== state.started && !0 !== state.finished && 0 === Number(state.checkpointIndex || 0))) return {
			up: !0,
			right: !1,
			down: !1,
			left: !1
		};
		return this.latestControls;
	}

	buildEnvSpec(bestWorkerId = null) {
		const workerPaletteId = "string" == typeof this.status.workerId && "-" !== this.status.workerId ? this.status.workerId : this.envKey;
		const isBest = workerPaletteId === bestWorkerId;
		return {
			envKey: this.envKey,
			workerId: "string" == typeof this.status.workerId && "-" !== this.status.workerId ? this.status.workerId : null,
			resetSequence: this.resetSequence,
			controls: this.appliedControls(this.lastState),
			colors: vidvudsClusterWorkerPalette(workerPaletteId, isBest),
			opacity: isBest ? 0.86 : 0.42
		};
	}

	updateFromState(track, state, runtimeMetrics) {
		this.lastState = state;
		this.episodeTimedOut(state) && this.requestReset("timeout");
		return this.statePayload(runtimeMetrics);
	}

	statePayload(runtimeMetrics) {
		if (null == this.lastState || !this.lastState.active) return null;
		return {
			envKey: this.envKey,
			sessionId: this.sessionId,
			state: this.lastState,
			runtime: runtimeMetrics
		};
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = !0;
	}
}

class VidvudsTrainingRuntime {
	constructor(config) {
		this.config = vidvudsNormalizeTrainingConfig(config);
		this.embeddedWorker = "embedded" === this.config.workerMode || vidvudsIsEmbeddedTrainingWorker();
		this.useEmbeddedClusterWorkers = !1;
		this.sensorConfig = vidvudsCreateSensorConfig(this.config);
		this.sessionId = `${Date.now()}-${Math.floor(1e6 * Math.random())}`;
		this.latestControls = vidvudsNormalizeControls();
		this.visionPanel = null;
		this.clusterPanel = null;
		this.clusterTrack = null;
		this.clusterWorkers = new Map;
		this.extraClients = new Map;
		this.socket = null;
		this.reconnectTimer = null;
		this.disposed = false;
			this.frameTimestamps = [];
			this.decisionWallTimestamps = [];
			this.decisionSimTimestamps = [];
			this.appliedTimeScale = 1;
			this.lastSentFrame = -1;
			this.lastDecisionSimTime = -1;
			this.decisionIntervalSeconds = 1 / Math.max(Number(this.config.decisionHz) || vidvudsTrainingDefaults.decisionHz, 1);
			this.resetPending = !1;
			this.persistSpectatorOnReset = !1;
			this.persistedSpectatorPose = null;
			this.spectatorRestorePending = !1;
			this.lastResetReason = "";
			this.clusterTrackPosted = !1;
			this.primaryClusterKey = null;
			this.receivedPrimaryControl = !1;
			this.extraEnvSyncError = "";
			this.lastLoggedExtraEnvSyncError = "";
			this.activeLaunchHeartbeatAt = 0;
			this.lastObservedStateActive = null;
			this.helloSent = !1;
			this.needsReconnectReset = !1;
			this.deferHelloUntilReset = !1;
			this.resetRetryAtMs = 0;
			this.resetRetryCount = 0;
			this.handleWorkerMessage = event => {
			if (this.disposed || this.embeddedWorker) return;
			const message = event && event.data;
			if (null == message || "object" != typeof message || "vidvuds-training-worker-status" !== message.type) return;
			if (message.launchKey !== this.config.launchKey) return;
			const status = null != message.status && "object" == typeof message.status ? message.status : null;
			const workerId = "string" == typeof(status && status.workerId) ? status.workerId : null;
			if (!workerId) return;
			null != message.track && "object" == typeof message.track && (this.clusterTrack = message.track);
			this.clusterWorkers.set(workerId, {
				workerId,
				liveState: null != message.liveState && "object" == typeof message.liveState ? message.liveState : null,
				status: status || {},
				isLocal: !1,
				updatedAt: performance.now()
			});
			this.refreshClusterPanel();
		};
		this.status = {
			connection: "connecting",
			action: "idle",
			trainer: "waiting",
			workerId: "-",
			episode: 0,
			episodeStep: 0,
			globalStep: 0,
			workerStep: 0,
			episodeReturn: 0,
			bestReturn: 0,
			bestEpisodeReturn: 0,
			meanEpisodeReturn: 0,
			updates: 0,
			policyLoss: null,
			valueLoss: null,
			entropy: null,
			lastResetReason: "startup",
			checkpointIndex: 0,
			totalCheckpoints: 0,
			finishedRuns: 0,
			connectedWorkers: 0,
			targetWorkers: this.config.workerCount,
			rolloutFill: 0,
			rolloutTarget: 0,
			stepsPerSecond: 0,
			bestWorkerId: null,
			requestedTimeScale: Number(this.config.timeScale) || 1,
			appliedTimeScale: 1,
			wallFps: 0,
			wallDecisionRate: 0,
			simDecisionRate: 0,
			dashboardUrl: vidvudsDeriveDashboardUrl(this.config.serverUrl, this.config.dashboardFocus)
		};
		this.root = vidvudsCreateElement("div", "training-runtime connecting");
		this.embeddedWorker && this.root.classList.add("embedded");
		this.header = vidvudsCreateElement("div", "header");
		this.title = vidvudsCreateElement("h2", "", "Training");
		this.connectionLabel = vidvudsCreateElement("p", "", "Connecting");
		this.header.appendChild(this.title);
		this.header.appendChild(this.connectionLabel);
		this.root.appendChild(this.header);
		const hint = vidvudsCreateElement("p", "hint");
		hint.innerHTML = 'Python server: <code>python -m training</code>';
		this.root.appendChild(hint);
		this.metrics = vidvudsCreateElement("div", "metrics");
		this.metricNodes = new Map;
		["Worker", "Workers", "Time Scale", "Action", "Checkpoint", "Episode", "Episode Return", "Best Return", "Cluster Best", "Rollout", "Train Steps/s", "Updates", "Last Reset"].forEach((label => {
			const metric = vidvudsCreateElement("div", "metric");
			const title = vidvudsCreateElement("p", "", label);
			const value = vidvudsCreateElement("strong", "", "-");
			metric.appendChild(title);
			metric.appendChild(value);
			this.metrics.appendChild(metric);
			this.metricNodes.set(label, value);
		}));
		this.root.appendChild(this.metrics);
		const buttonRow = vidvudsCreateElement("div", "button-row");
		const dashboardButton = vidvudsCreateElement("button", "button", "Dashboard");
		dashboardButton.addEventListener("click", (() => {
			vidvudsOpenDashboardWindow(this.config);
		}));
		buttonRow.appendChild(dashboardButton);
		const reconnectButton = vidvudsCreateElement("button", "button", "Reconnect");
		reconnectButton.addEventListener("click", (() => {
			this.connect(!0);
		}));
		buttonRow.appendChild(reconnectButton);
			const resetButton = vidvudsCreateElement("button", "button", "Reset Car");
			resetButton.addEventListener("click", (() => {
				this.requestReset("manual", {
					includeExtraClients: !0
				});
			}));
			buttonRow.appendChild(resetButton);
		const visionButton = vidvudsCreateElement("button", "button", "Vision");
		visionButton.addEventListener("click", (() => {
			this.toggleVision();
		}));
		buttonRow.appendChild(visionButton);
			this.cameraButton = vidvudsCreateElement("button", "button", "Drone Cam");
			this.cameraButton.addEventListener("click", (() => {
				this.toggleSpectator();
			}));
		buttonRow.appendChild(this.cameraButton);
		const stopButton = vidvudsCreateElement("button", "button", "Stop");
		stopButton.addEventListener("click", (() => {
			window.vidvudsTrainingMode.stop();
		}));
		buttonRow.appendChild(stopButton);
		this.root.appendChild(buttonRow);
		document.getElementById("ui").appendChild(this.root);
		if (!this.embeddedWorker) {
			if (this.useEmbeddedClusterWorkers) {
				window.addEventListener("message", this.handleWorkerMessage);
				const launchedWorkers = vidvudsLaunchEmbeddedWorkers({
					launchKey: this.config.launchKey,
					config: {
						...this.config
					}
				});
				this.config.blockedWorkers = Math.max((Number(this.config.workerCount) || 1) - launchedWorkers, 0);
			}
			this.clusterTrack = vidvudsSafeGetTrackData();
		}
		this.ensureExtraClients();
		this.updateUi();
		vidvudsEnsureDebugSocket(this.config.serverUrl);
		vidvudsDebugLog("runtime_constructor", {
			sessionId: this.sessionId,
			embeddedWorker: this.embeddedWorker,
			config: this.config
		});
		this.connect(!1);
	}

	setConnectionState(state, label) {
		this.status.connection = state;
		this.connectionLabel.textContent = label;
		this.root.classList.remove("connecting", "connected", "error", "disconnected");
		this.root.classList.add(state);
	}

	toggleVision(forceVisible) {
		if (this.embeddedWorker) return;
		const shouldShow = "boolean" == typeof forceVisible ? forceVisible : null == this.visionPanel;
		if (!shouldShow) {
			null != this.visionPanel && (this.visionPanel.dispose(), this.visionPanel = null);
			return;
		}
		null == this.visionPanel && (this.visionPanel = new VidvudsTrainingVisionPanel);
	}

		toggleSpectator(forceEnabled) {
			if (this.embeddedWorker) return;
			const api = vidvudsSafeTrainingApi();
			if (null == api || "function" != typeof api.setSpectatorEnabled) return;
			const state = vidvudsSafeGetState();
			const enabled = "boolean" == typeof forceEnabled ? forceEnabled : !(null != state && !0 === state.spectator);
			this.persistSpectatorOnReset = enabled;
			!enabled && (this.persistedSpectatorPose = null, this.spectatorRestorePending = !1);
			try {
				enabled && null != this.persistedSpectatorPose ? api.setSpectatorEnabled(!0, this.persistedSpectatorPose) : api.setSpectatorEnabled(enabled);
			} catch (error) {
				console.error(error);
			}
		}

		captureSpectatorPose(api = vidvudsSafeTrainingApi()) {
			if (this.embeddedWorker || null == api || "function" != typeof api.getSpectatorPose) return;
			try {
				const pose = api.getSpectatorPose();
				null != pose && null != pose.position && null != pose.quaternion && (this.persistedSpectatorPose = {
					position: {
						x: Number(pose.position.x) || 0,
						y: Number(pose.position.y) || 0,
						z: Number(pose.position.z) || 0
					},
					quaternion: {
						x: Number(pose.quaternion.x) || 0,
						y: Number(pose.quaternion.y) || 0,
						z: Number(pose.quaternion.z) || 0,
						w: Number(pose.quaternion.w) || 1
					}
				});
			} catch (error) {}
		}

	connect(forceReconnect) {
		if (this.disposed) return;
		this.ensureExtraClients();
		null != this.reconnectTimer && (clearTimeout(this.reconnectTimer), this.reconnectTimer = null);
		if (forceReconnect) {
			null != this.socket && this.socket.close();
			this.socket = null;
		}
		if (null != this.socket && this.socket.readyState === WebSocket.OPEN) return;
		try {
			vidvudsEnsureDebugSocket(this.config.serverUrl);
			vidvudsDebugLog("runtime_socket_connecting", {
				sessionId: this.sessionId,
				forceReconnect: !!forceReconnect,
				serverUrl: this.config.serverUrl
			});
			this.setConnectionState("connecting", "Connecting");
				this.socket = new WebSocket(this.config.serverUrl);
				this.socket.addEventListener("open", (() => {
					this.receivedPrimaryControl = !1;
					this.helloSent = !1;
					this.setConnectionState("connected", "Connected");
					vidvudsDebugLog("runtime_socket_open", {
						sessionId: this.sessionId,
						serverUrl: this.config.serverUrl
					});
					if (this.needsReconnectReset) {
						this.needsReconnectReset = !1;
						if (this.requestReset("reconnect_sync", {
							includeExtraClients: !0,
							notifyTrainer: !1,
							debugEvent: "runtime_reconnect_reset"
						})) {
							this.deferHelloUntilReset = !0;
							return;
						}
					}
					this.sendHello();
				}));
			this.socket.addEventListener("message", (event => {
				this.handleMessage(event.data);
			}));
			this.socket.addEventListener("error", (() => {
				this.setConnectionState("error", "Socket Error");
				vidvudsDebugLog("runtime_socket_error", {
					sessionId: this.sessionId,
					serverUrl: this.config.serverUrl
				});
			}));
				this.socket.addEventListener("close", (event => {
					this.latestControls = vidvudsNormalizeControls();
					this.helloSent = !1;
					this.needsReconnectReset = !this.disposed;
					this.setConnectionState("disconnected", "Retrying");
					vidvudsDebugLog("runtime_socket_close", {
						sessionId: this.sessionId,
					code: event.code,
					reason: event.reason,
					wasClean: event.wasClean
				});
				if (!this.disposed) {
					this.reconnectTimer = window.setTimeout((() => {
						this.connect(!0);
					}), 1500);
				}
			}));
		} catch (error) {
			console.error(error);
			vidvudsDebugLog("runtime_socket_connect_failed", {
				sessionId: this.sessionId,
				error
			});
			this.setConnectionState("error", "Connect Failed");
		}
	}

	send(message) {
		if (null == this.socket || this.socket.readyState !== WebSocket.OPEN) return;
		this.socket.send(JSON.stringify(message));
	}

	sendHello() {
		this.helloSent = !0;
		this.deferHelloUntilReset = !1;
		vidvudsDebugLog("runtime_send_hello", {
			sessionId: this.sessionId,
			track: vidvudsDebugTrackSummary(this.config),
			sensorConfig: this.sensorConfig
		});
		this.send({
			type: "hello",
			protocol: "vidvuds-training-v2",
			sessionId: this.sessionId,
			config: this.config,
			sensorConfig: this.sensorConfig,
			track: vidvudsSafeGetTrackData(),
			state: vidvudsCompactTrainingState(vidvudsSafeGetState())
		});
	}

	handleMessage(raw) {
		let message;
		try {
			message = JSON.parse(raw);
		} catch (error) {
			console.error(error);
			return;
		}
		if (null == message || "object" != typeof message) return;
		if ("hello" == message.type) {
			this.status.trainer = "string" == typeof message.trainer ? message.trainer : "ppo";
			this.status.workerId = "string" == typeof message.workerId ? message.workerId : this.status.workerId;
			this.status.rolloutTarget = Number.isFinite(message.rolloutSteps) ? message.rolloutSteps : this.status.rolloutTarget;
			this.status.dashboardUrl = "string" == typeof message.dashboardUrl ? message.dashboardUrl : this.status.dashboardUrl;
			this.resetPending = !1;
			this.lastDecisionSimTime = -1;
			vidvudsDebugLog("runtime_trainer_hello", {
				sessionId: this.sessionId,
				workerId: this.status.workerId,
				rolloutTarget: this.status.rolloutTarget,
				dashboardUrl: this.status.dashboardUrl
			});
		} else if ("control" == message.type) {
			this.receivedPrimaryControl = !0;
			this.latestControls = vidvudsNormalizeControls(message.controls);
			message.reset ? this.requestReset(message.reason) : this.resetPending = !1;
			message.reset && vidvudsDebugLog("runtime_trainer_reset", {
				sessionId: this.sessionId,
				reason: message.reason,
				workerId: this.status.workerId
			});
			null != message.status && this.mergeStatus(message.status);
			Array.isArray(message.extraControls) && message.extraControls.forEach((entry => {
				const envKey = "string" == typeof(entry && entry.envKey) ? entry.envKey : null;
				if (!envKey) return;
				const client = this.extraClients.get(envKey);
				null != client && client.applyServerControl({
					type: "control",
					workerId: entry.workerId,
					controls: entry.controls,
					reset: entry.reset,
					reason: entry.reason,
					status: entry.status
				});
			}));
		} else if ("status" == message.type) {
			null != message.status && this.mergeStatus(message.status);
		} else if ("error" == message.type) {
			this.setConnectionState("error", "Trainer Error");
			null != message.message && (this.status.lastResetReason = message.message);
			vidvudsDebugLog("runtime_trainer_error", {
				sessionId: this.sessionId,
				message: message.message
			});
		}
		this.updateUi();
	}

		requestReset(reason, options = null) {
			const api = vidvudsSafeTrainingApi();
			this.status.lastResetReason = "string" == typeof reason && reason.length > 0 ? reason : "server";
			const includeExtraClients = !!(options && options.includeExtraClients);
			const notifyTrainer = !1 !== (options && options.notifyTrainer);
			const debugEvent = "string" == typeof(options && options.debugEvent) && options.debugEvent.length > 0 ? options.debugEvent : "runtime_request_reset";
			if (!this.resetPending && null != api && "function" == typeof api.resetCar) {
				this.resetPending = !0;
				this.resetRetryCount = 0;
				this.resetRetryAtMs = performance.now() + 250;
				this.lastResetReason = this.status.lastResetReason;
				includeExtraClients && this.extraClients.forEach((client => {
					null != client && client.requestReset(this.status.lastResetReason);
				}));
				this.persistSpectatorOnReset && (this.captureSpectatorPose(api), this.spectatorRestorePending = !0);
				vidvudsDebugLog(debugEvent, {
					sessionId: this.sessionId,
					reason: this.status.lastResetReason,
					workerId: this.status.workerId
				});
				api.resetCar();
				notifyTrainer && this.send({
					type: "event",
					event: "client_reset",
					reason: this.status.lastResetReason
				});
				return !0;
			}
			return !1;
		}

	mergeStatus(status) {
		for (const [key, value] of Object.entries(status)) this.status[key] = value;
	}

	ensureExtraClients() {
		if (this.embeddedWorker || this.useEmbeddedClusterWorkers) return;
		const targetCount = Math.max(Number(this.config.workerCount) || 1, 1) - 1;
		for (let index = 0; index < targetCount; index++) {
			const envKey = `env-${index + 2}`;
			if (this.extraClients.has(envKey)) continue;
			const client = new VidvudsTrainingEnvWorkerClient(this, envKey, index + 2);
			this.extraClients.set(envKey, client);
		}
		Array.from(this.extraClients.entries()).forEach((([envKey, client]) => {
			const slotIndex = Number((envKey.match(/(\d+)$/) || [])[1]) || 0;
			if (slotIndex >= 2 && slotIndex <= targetCount + 1) return;
			client.dispose();
			this.extraClients.delete(envKey);
			this.clusterWorkers.delete(client.lastClusterKey);
		}));
	}

	updateClusterExtraClientState(client, state) {
		if (this.embeddedWorker || null == client) return;
		null == this.clusterTrack && (this.clusterTrack = vidvudsSafeGetTrackData());
		const workerId = client.clusterKey();
		client.lastClusterKey !== workerId && this.clusterWorkers.delete(client.lastClusterKey);
		client.lastClusterKey = workerId;
		if (null == state || !state.active) {
			this.clusterWorkers.delete(workerId);
			return;
		}
		this.clusterWorkers.set(workerId, {
			workerId,
			liveState: vidvudsCompactClusterMapState(state),
			status: {
				...client.status
			},
			isLocal: !0,
			updatedAt: performance.now()
		});
	}

	pruneClusterWorkers() {
		if (this.embeddedWorker) return;
		const now = performance.now();
		Array.from(this.clusterWorkers.entries()).forEach((([workerId, worker]) => {
			if (worker && now - Number(worker.updatedAt || 0) <= 3e3) return;
			this.clusterWorkers.delete(workerId);
		}));
	}

	refreshClusterPanel() {
		if (this.embeddedWorker || null == this.clusterPanel) return;
		this.pruneClusterWorkers();
		this.clusterPanel.update({
			track: this.clusterTrack,
			workers: Array.from(this.clusterWorkers.values()),
			connectedWorkers: this.status.connectedWorkers,
			targetWorkers: this.status.targetWorkers,
			bestWorkerId: this.status.bestWorkerId
		});
		this.pushClusterSceneCars();
	}

	pushClusterSceneCars() {
		if (this.embeddedWorker) return;
		const api = vidvudsSafeTrainingApi();
		if (null == api) return;
		if (this.extraClients.size > 0) {
			"function" == typeof api.clearClusterCars && api.clearClusterCars();
			return;
		}
		const cars = vidvudsCreateClusterScenePayload(this.clusterWorkers, this.status.bestWorkerId, this.clusterTrack, this.status.targetWorkers);
		if ("function" == typeof api.setClusterCars) {
			api.setClusterCars(cars);
		} else if (0 === cars.length && "function" == typeof api.clearClusterCars) {
			api.clearClusterCars();
		}
	}

	updateClusterLocalState(state) {
		if (this.embeddedWorker) return;
		null == this.clusterTrack && (this.clusterTrack = vidvudsSafeGetTrackData());
		const workerId = "string" == typeof this.status.workerId && "-" !== this.status.workerId ? this.status.workerId : null;
		if (null == workerId) {
			null != this.primaryClusterKey && this.clusterWorkers.delete(this.primaryClusterKey);
			this.primaryClusterKey = null;
			this.refreshClusterPanel();
			return;
		}
		null != this.primaryClusterKey && this.primaryClusterKey !== workerId && this.clusterWorkers.delete(this.primaryClusterKey);
		this.primaryClusterKey = workerId;
		if (null == state || !state.active) {
			this.clusterWorkers.delete(workerId);
			this.refreshClusterPanel();
			return;
		}
		this.clusterWorkers.set(workerId, {
			workerId,
			liveState: vidvudsCompactClusterMapState(state),
			status: {
				...this.status
			},
			isLocal: !0,
			updatedAt: performance.now()
		});
		this.refreshClusterPanel();
	}

	computeAppliedTimeScale() {
		const decisionHz = Math.max(Number(this.config.decisionHz) || vidvudsTrainingDefaults.decisionHz, 1);
		const requested = Math.max(Number(this.config.timeScale) || 1, vidvudsMinimumTimeScale(decisionHz));
		const observedWallFps = Math.max(Number(this.status.wallFps) || 0, this.frameTimestamps.length < 12 ? 60 : 0);
		const safeMaximum = Math.max(vidvudsMinimumTimeScale(decisionHz), observedWallFps / decisionHz);
		return vidvudsClamp(requested, vidvudsMinimumTimeScale(decisionHz), safeMaximum);
	}

	updateTimingStatus(nowSeconds) {
		vidvudsPushSample(this.frameTimestamps, nowSeconds, 120);
		this.status.wallFps = vidvudsEstimateRate(this.frameTimestamps);
		this.status.requestedTimeScale = Number(this.config.timeScale) || 1;
		this.appliedTimeScale = this.computeAppliedTimeScale();
		this.status.appliedTimeScale = this.appliedTimeScale;
		this.status.wallDecisionRate = vidvudsEstimateRate(this.decisionWallTimestamps);
		const simElapsed = this.decisionSimTimestamps.length >= 2 ? this.decisionSimTimestamps[this.decisionSimTimestamps.length - 1] - this.decisionSimTimestamps[0] : 0;
		this.status.simDecisionRate = simElapsed > 1e-6 ? (this.decisionSimTimestamps.length - 1) / simElapsed : 0;
	}

	recordDecision(nowSeconds, simTime) {
		if (this.decisionSimTimestamps.length > 0 && simTime + 1e-6 < this.decisionSimTimestamps[this.decisionSimTimestamps.length - 1]) {
			this.decisionWallTimestamps.length = 0;
			this.decisionSimTimestamps.length = 0;
		}
		vidvudsPushSample(this.decisionWallTimestamps, nowSeconds, 90);
		vidvudsPushSample(this.decisionSimTimestamps, simTime, 90);
		this.status.wallDecisionRate = vidvudsEstimateRate(this.decisionWallTimestamps);
		const simElapsed = this.decisionSimTimestamps.length >= 2 ? this.decisionSimTimestamps[this.decisionSimTimestamps.length - 1] - this.decisionSimTimestamps[0] : 0;
		this.status.simDecisionRate = simElapsed > 1e-6 ? (this.decisionSimTimestamps.length - 1) / simElapsed : 0;
	}

	runtimeMetricsPayload() {
		return {
			requestedTimeScale: this.status.requestedTimeScale,
			appliedTimeScale: this.status.appliedTimeScale,
			wallFps: this.status.wallFps,
			wallDecisionRate: this.status.wallDecisionRate,
			simDecisionRate: this.status.simDecisionRate
		};
	}

	postClusterStatusToParent() {
		if (window.self === window.top || null == window.parent) return;
		try {
			const liveState = vidvudsCompactClusterMapState(vidvudsSafeGetState());
			const track = !this.clusterTrackPosted ? vidvudsSafeGetTrackData() : null;
			null != track && (this.clusterTrackPosted = !0);
			window.parent.postMessage({
				type: "vidvuds-training-worker-status",
				launchKey: this.config.launchKey,
				workerMode: this.config.workerMode,
				track,
				liveState,
				status: {
					...this.status,
					requestedTimeScale: this.status.requestedTimeScale,
					appliedTimeScale: this.status.appliedTimeScale,
					wallFps: this.status.wallFps,
					wallDecisionRate: this.status.wallDecisionRate,
					simDecisionRate: this.status.simDecisionRate
				}
			}, "*");
		} catch (error) {}
	}

	updateUi() {
		const state = vidvudsSafeGetState();
		const checkpointText = null != state ? `${state.checkpointIndex}/${state.totalCheckpoints}` : "-";
		const launchAssistActive = null != state && !0 !== state.started && !0 !== state.finished && 0 === Number(state.checkpointIndex);
		const actionLabel = launchAssistActive ? "launch_assist" : this.status.action;
		const requestedScale = Number(this.status.requestedTimeScale || this.config.timeScale || 1);
		const appliedScale = Number(this.status.appliedTimeScale || requestedScale);
		this.metricNodes.get("Worker").textContent = `${this.status.workerId}`;
		this.metricNodes.get("Workers").textContent = `${this.status.connectedWorkers}/${this.status.targetWorkers}`;
		this.metricNodes.get("Time Scale").textContent = Math.abs(appliedScale - requestedScale) > .01 ? `${requestedScale.toFixed(2)}x req | ${appliedScale.toFixed(2)}x live` : `${appliedScale.toFixed(2)}x`;
		this.metricNodes.get("Action").textContent = `${actionLabel} | ${vidvudsTrainingActionSpaces[this.config.actionSpace].label}`;
		this.metricNodes.get("Checkpoint").textContent = checkpointText;
		this.metricNodes.get("Episode").textContent = `${this.status.episode} | step ${this.status.episodeStep}`;
		this.metricNodes.get("Episode Return").textContent = Number(this.status.episodeReturn).toFixed(2);
		this.metricNodes.get("Best Return").textContent = Number(this.status.bestReturn).toFixed(2);
		this.metricNodes.get("Cluster Best").textContent = `${Number(this.status.bestEpisodeReturn).toFixed(2)} | mean ${Number(this.status.meanEpisodeReturn).toFixed(2)}`;
		this.metricNodes.get("Rollout").textContent = `${this.status.rolloutFill}/${this.status.rolloutTarget}`;
		this.metricNodes.get("Train Steps/s").textContent = Number(this.status.stepsPerSecond).toFixed(1);
		this.metricNodes.get("Updates").textContent = `${this.status.updates} | best ${this.status.bestWorkerId || "-"}`;
				this.metricNodes.get("Last Reset").textContent = this.status.lastResetReason;
			if (null != this.cameraButton) {
				const spectatorEnabled = null != state && !0 === state.spectator;
				this.cameraButton.textContent = spectatorEnabled ? "Exit Drone Cam" : "Drone Cam";
				this.cameraButton.title = spectatorEnabled ? "Press Esc to leave drone cam." : "Click to lock the mouse and rotate the drone camera. Use WASD to move the free camera.";
			}
		this.postClusterStatusToParent();
	}

		update() {
		if (this.disposed) return;
		const api = vidvudsSafeTrainingApi();
		if (null == api) return;
			this.ensureExtraClients();
				const nowSeconds = .001 * performance.now();
				this.updateTimingStatus(nowSeconds);
				if ("function" == typeof api.configureSensors) {
					api.configureSensors(this.sensorConfig);
				}
			"function" == typeof api.setManualFallbackEnabled && api.setManualFallbackEnabled(this.config.manualFallback);
			"function" == typeof api.setTimeScale && api.setTimeScale(this.appliedTimeScale);
			null == this.clusterTrack && (this.clusterTrack = vidvudsSafeGetTrackData());
			const runtimeMetrics = this.runtimeMetricsPayload();
			const syncExtraEnvWorkers = () => {
				if (this.useEmbeddedClusterWorkers) return [];
				const track = this.clusterTrack || vidvudsSafeGetTrackData();
				null != track && (this.clusterTrack = track);
				try {
					const specs = Array.from(this.extraClients.values()).map((client => client.buildEnvSpec(this.status.bestWorkerId)));
					"function" == typeof api.syncTrainingEnvs && api.syncTrainingEnvs(specs);
					const envStates = "function" == typeof api.getTrainingEnvStates ? api.getTrainingEnvStates(this.sensorConfig) : [];
					const envStateMap = new Map;
					const extraStatePayloads = [];
					Array.isArray(envStates) && envStates.forEach((entry => {
						const envKey = "string" == typeof(entry && entry.envKey) ? entry.envKey : null;
						if (!envKey) return;
						envStateMap.set(envKey, vidvudsCompactTrainingState(entry.state));
					}));
					this.extraClients.forEach((client => {
						const envState = envStateMap.get(client.envKey) || null;
						const payload = client.updateFromState(this.clusterTrack, envState, runtimeMetrics);
						this.updateClusterExtraClientState(client, envState);
						null != payload && extraStatePayloads.push(payload);
					}));
					this.extraEnvSyncError = "";
					return extraStatePayloads;
				} catch (error) {
					console.error(error);
					this.extraEnvSyncError = error && error.message ? String(error.message) : "env_sync_error";
					this.lastLoggedExtraEnvSyncError !== this.extraEnvSyncError && (vidvudsDebugLog("runtime_extra_env_sync_error", {
						sessionId: this.sessionId,
						error,
						message: this.extraEnvSyncError
					}), this.lastLoggedExtraEnvSyncError = this.extraEnvSyncError);
					"function" == typeof api.clearTrainingEnvs && api.clearTrainingEnvs();
					this.extraClients.forEach((client => {
						client.lastState = null;
						this.updateClusterExtraClientState(client, null);
					}));
					return [];
				}
			};
		const state = vidvudsSafeGetState();
		const stateActive = null != state && !0 === state.active;
		if (this.lastObservedStateActive !== stateActive) {
			vidvudsDebugLog("runtime_state_active_change", {
				sessionId: this.sessionId,
				active: stateActive,
				mode: vidvudsSafeGetMode(),
				frame: null != state ? state.frame : null,
				started: null != state ? state.started : null,
				finished: null != state ? state.finished : null,
				timeSeconds: null != state ? state.timeSeconds : null
			});
			this.lastObservedStateActive = stateActive;
		}
		if (null == state || !state.active) {
			"function" == typeof api.setControls && api.setControls(this.latestControls);
			"function" == typeof api.clearTrainingEnvs && api.clearTrainingEnvs();
			this.extraClients.forEach((client => {
				client.lastState = null;
				this.updateClusterExtraClientState(client, null);
			}));
			"" !== this.lastLoggedExtraEnvSyncError && (vidvudsDebugLog("runtime_extra_env_sync_recovered", {
				sessionId: this.sessionId
			}), this.lastLoggedExtraEnvSyncError = "");
			null != this.visionPanel && this.visionPanel.update(null, this.sensorConfig);
			this.updateClusterLocalState(null);
			this.updateUi();
			return;
			}
					!this.embeddedWorker && !0 === state.spectator && this.captureSpectatorPose(api);
					const resetStateReached = Number(state.timeSeconds) < 2 && 0 === Number(state.checkpointIndex);
					if (this.resetPending && resetStateReached) {
						this.lastDecisionSimTime = -1;
						this.decisionWallTimestamps.length = 0;
						this.decisionSimTimestamps.length = 0;
						this.resetRetryAtMs = 0;
						this.resetRetryCount = 0;
					} else if (this.resetPending && null != api && "function" == typeof api.resetCar) {
						const nowMs = performance.now();
						if (nowMs >= this.resetRetryAtMs) {
							this.resetRetryCount += 1;
							this.resetRetryAtMs = nowMs + 250;
							vidvudsDebugLog("runtime_retry_reset", {
								sessionId: this.sessionId,
								reason: this.lastResetReason || this.status.lastResetReason,
								workerId: this.status.workerId,
								retryCount: this.resetRetryCount,
								timeSeconds: Number(state.timeSeconds) || 0,
								checkpointIndex: Number(state.checkpointIndex) || 0
							});
							api.resetCar();
						}
					}
					if (this.deferHelloUntilReset && resetStateReached && null != this.socket && this.socket.readyState === WebSocket.OPEN) {
						this.sendHello();
				}
				if (this.spectatorRestorePending && this.persistSpectatorOnReset) {
					if (!0 === state.spectator) this.spectatorRestorePending = !1;
					else if (resetStateReached && "function" == typeof api.setSpectatorEnabled) api.setSpectatorEnabled(!0, this.persistedSpectatorPose);
				}
			const localEpisodeTimedOut = !this.resetPending && !this.deferHelloUntilReset && !0 === state.started && Number(state.timeSeconds) >= Number(this.config.episodeTimeoutSeconds || 0);
			if (localEpisodeTimedOut) {
				this.requestReset("timeout", {
					includeExtraClients: !0
				});
				this.updateClusterLocalState(state);
				this.updateUi();
				return;
			}
			const appliedControls = !0 !== state.started && !0 !== state.finished && 0 === Number(state.checkpointIndex) ? {
				up: !0,
				right: !1,
			down: !1,
			left: !1
		} : this.latestControls;
		"function" == typeof api.setControls && api.setControls(appliedControls);
		this.status.checkpointIndex = state.checkpointIndex;
		this.status.totalCheckpoints = state.totalCheckpoints;
		const extraStates = syncExtraEnvWorkers();
		"" !== this.lastLoggedExtraEnvSyncError && "" === this.extraEnvSyncError && (vidvudsDebugLog("runtime_extra_env_sync_recovered", {
			sessionId: this.sessionId
		}), this.lastLoggedExtraEnvSyncError = "");
		null != this.visionPanel && this.visionPanel.update(state, this.sensorConfig);
		this.updateClusterLocalState(state);
		this.updateUi();
			const simTime = Number(state.timeSeconds) || 0;
		if (simTime < this.lastDecisionSimTime) {
			this.lastDecisionSimTime = -1;
			this.decisionWallTimestamps.length = 0;
			this.decisionSimTimestamps.length = 0;
		}
			const shouldSendStartedState = !0 === state.started && (this.lastDecisionSimTime < 0 || simTime - this.lastDecisionSimTime >= this.decisionIntervalSeconds - 1e-6);
			const shouldSendTerminalState = !0 === state.finished && !this.resetPending;
			const shouldSendStartupState = !0 !== state.started;
				const shouldSendState = this.helloSent && null != this.socket && this.socket.readyState === WebSocket.OPEN && state.frame !== this.lastSentFrame && (shouldSendStartupState || shouldSendStartedState || shouldSendTerminalState);
		if (shouldSendState) {
			this.lastSentFrame = state.frame;
			if (!0 === state.started) {
				this.lastDecisionSimTime = simTime;
				this.recordDecision(nowSeconds, simTime);
			}
			this.send({
				type: "state",
				sessionId: this.sessionId,
				state: vidvudsCompactTrainingState(state),
				runtime: runtimeMetrics,
				extraStates
			});
		}
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = !0;
		vidvudsDebugLog("runtime_dispose", {
			sessionId: this.sessionId,
			workerId: this.status.workerId
		});
		null != this.reconnectTimer && clearTimeout(this.reconnectTimer);
		null != this.socket && this.socket.close();
		this.extraClients.forEach((client => {
			client.dispose();
		}));
		this.extraClients.clear();
		null != this.visionPanel && (this.visionPanel.dispose(), this.visionPanel = null);
		!this.embeddedWorker && window.removeEventListener("message", this.handleWorkerMessage);
		null != this.clusterPanel && (this.clusterPanel.dispose(), this.clusterPanel = null);
		this.clusterWorkers.clear();
		const api = vidvudsSafeTrainingApi();
		if (null != api) {
			"function" == typeof api.clearControls && api.clearControls();
			"function" == typeof api.clearTrainingEnvs && api.clearTrainingEnvs();
			"function" == typeof api.clearClusterCars && api.clearClusterCars();
			"function" == typeof api.setManualFallbackEnabled && api.setManualFallbackEnabled(!0);
			"function" == typeof api.setTimeScale && api.setTimeScale(1);
		}
		!this.embeddedWorker && vidvudsClearWorkerEmbeds();
		null != this.root.parentNode && this.root.parentNode.removeChild(this.root);
	}
}

function vidvudsEnsureRuntime(mode = vidvudsSafeGetMode()) {
	if (null != vidvudsTrainingState.pendingLaunch && "play" === mode && null == vidvudsTrainingState.runtime) {
		vidvudsDebugLog("runtime_create_requested", {
			pendingLaunch: vidvudsTrainingState.pendingLaunch
		});
		vidvudsTrainingState.runtime = new VidvudsTrainingRuntime(vidvudsTrainingState.pendingLaunch);
		vidvudsDebugLog("runtime_create_succeeded", {
			sessionId: vidvudsTrainingState.runtime.sessionId,
			pendingLaunch: vidvudsTrainingState.pendingLaunch
		});
		vidvudsTrainingState.pendingLaunch = null;
	}
	if (null != vidvudsTrainingState.runtime) {
		if ("play" !== mode) {
			vidvudsDebugLog("runtime_dispose_due_to_mode", {
				mode,
				workerId: vidvudsTrainingState.runtime.status.workerId
			});
			vidvudsTrainingState.runtime.dispose();
			vidvudsTrainingState.runtime = null;
		} else vidvudsTrainingState.runtime.update();
	}
}

function vidvudsTrainingLoop() {
	const mode = vidvudsSafeGetMode();
	if (mode !== vidvudsTrainingDebugState.lastMode) {
		vidvudsDebugLog("mode_change", {
			from: vidvudsTrainingDebugState.lastMode,
			to: mode,
			pendingLaunch: null != vidvudsTrainingState.pendingLaunch,
			runtimeActive: null != vidvudsTrainingState.runtime
		});
		vidvudsTrainingDebugState.lastMode = mode;
	}
	vidvudsTryAutoLaunchIntoTrainingMenu();
	vidvudsEnsureRuntime(mode);
	window.requestAnimationFrame(vidvudsTrainingLoop);
}

window.vidvudsTrainingMode = {
	openMenu(options) {
		try {
			const autoLaunch = vidvudsGetAutoLaunchRequest();
			null != autoLaunch && (vidvudsTrainingState.autoLaunch = null);
			null != vidvudsTrainingState.panel && vidvudsTrainingState.panel.dispose();
			vidvudsTrainingState.panel = new VidvudsTrainingMenuPanel({
				...options,
				initialConfig: null != autoLaunch ? autoLaunch.config : null != options.initialConfig ? options.initialConfig : vidvudsTrainingState.lastConfig,
				autoLaunch
			});
			const originalDispose = vidvudsTrainingState.panel.dispose.bind(vidvudsTrainingState.panel);
			vidvudsTrainingState.panel.dispose = () => {
				originalDispose();
				vidvudsTrainingState.panel = null;
			};
			return vidvudsTrainingState.panel;
		} catch (error) {
			console.error(error);
			vidvudsTrainingState.panel = null;
			"function" == typeof options.onClose && options.onClose();
			return null;
		}
	},
	openEditorMenu(options = {}) {
		const parent = options.parent || document.getElementById("ui");
		if (null == parent) return null;
		const externalTrack = vidvudsCreateExternalTrack({
			trackId: options.trackId,
			trackName: options.trackName,
			trackExportString: options.trackExportString,
			trackData: options.trackData,
			source: "editor"
		});
		const startExportTrack = "function" == typeof options.startExportTrack ? options.startExportTrack : ((exportString, trackInfo) => {
			const api = vidvudsSafeTrainingApi();
			return null != api && "function" == typeof api.startTrackExport ? api.startTrackExport(exportString, trackInfo) : null;
		});
		return this.openMenu({
			parent,
			locale: options.locale || null,
			audio: options.audio || null,
			onClose: options.onClose,
			startPlay: options.startPlay,
			startExportTrack,
			extraTracks: [externalTrack],
			initialConfig: {
				...vidvudsNormalizeTrainingConfig(vidvudsTrainingState.lastConfig),
				trackId: externalTrack.id,
				trackName: externalTrack.name
			}
		});
	},
	stop() {
		vidvudsClearActiveLaunchRequest();
		vidvudsTrainingState.autoLaunch = null;
		vidvudsTrainingState.autoLaunchTriggered = !1;
		vidvudsTrainingState.pendingLaunch = null;
		null != vidvudsTrainingState.runtime && (vidvudsTrainingState.runtime.dispose(), vidvudsTrainingState.runtime = null);
		vidvudsClearWorkerEmbeds();
	},
	toggleVision(forceVisible) {
		null != vidvudsTrainingState.runtime && vidvudsTrainingState.runtime.toggleVision(forceVisible);
	},
	getStatus() {
		return {
			pendingLaunch: null != vidvudsTrainingState.pendingLaunch,
			runtimeActive: null != vidvudsTrainingState.runtime,
			lastConfig: vidvudsTrainingState.lastConfig,
			status: null != vidvudsTrainingState.runtime ? vidvudsTrainingState.runtime.status : null
		};
	}
};

window.addEventListener("pagehide", (() => {
	vidvudsTrainingState.pageUnloading = !0;
	vidvudsDebugLog("pagehide");
}));

window.addEventListener("pageshow", (() => {
	vidvudsTrainingState.pageUnloading = !1;
	vidvudsDebugLog("pageshow");
}));

vidvudsTrainingLoop();
