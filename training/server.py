from __future__ import annotations

import argparse
import asyncio
import json
import errno
import threading
from collections import deque
from dataclasses import dataclass, field
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from time import monotonic
from typing import Any, Dict
from urllib.parse import quote

import websockets
from websockets.exceptions import ConnectionClosed

from .actions import get_action_space
from .features import flatten_state, progress_score, step_reward, wheel_contact_count
from .ppo import PPOAgent


def _safe_host(host: str) -> str:
    return "127.0.0.1" if host in {"0.0.0.0", "::"} else host


def build_dashboard_url(args: argparse.Namespace) -> str:
    host = _safe_host(args.dashboard_host or args.host)
    ws_host = _safe_host(args.host)
    ws_url = f"ws://{ws_host}:{args.port}"
    return f"http://{host}:{args.dashboard_port}/training/dashboard/index.html?ws={quote(ws_url, safe='')}"


def _min_time_scale() -> float:
    return 0.05


def _compact_json(value: Any, limit: int = 320) -> str:
    try:
        text = json.dumps(value, ensure_ascii=True, separators=(",", ":"), default=str)
    except TypeError:
        text = repr(value)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _trainer_log(message: str, **fields: Any) -> None:
    suffix = " ".join(
        f"{key}={_compact_json(value, 180)}"
        for key, value in fields.items()
        if value is not None
    )
    print(f"[trainer] {message}" + (f" {suffix}" if suffix else ""), flush=True)


@dataclass
class PendingTransition:
    observation: list[float]
    action: int
    log_prob: float
    value: float
    reward: float
    done: bool


@dataclass
class WorkerSession:
    worker_id: str
    config: Dict[str, Any] = field(default_factory=dict)
    track: Dict[str, Any] = field(default_factory=dict)
    sensor_config: Dict[str, Any] = field(default_factory=dict)
    previous_state: Dict[str, Any] | None = None
    previous_observation: list[float] | None = None
    previous_action: int | None = None
    previous_log_prob: float | None = None
    previous_value: float | None = None
    current_state: Dict[str, Any] | None = None
    current_observation: list[float] | None = None
    pending_rollout: list[PendingTransition] = field(default_factory=list)
    pending_reset: bool = False
    episode: int = 1
    episode_step: int = 0
    total_steps: int = 0
    episode_return: float = 0.0
    best_return: float = float("-inf")
    best_progress: float = float("-inf")
    last_progress_time: float = 0.0
    finished_runs: int = 0
    last_reset_reason: str = "startup"
    current_action_label: str = "idle"
    current_time_seconds: float = 0.0
    checkpoint_index: int = 0
    total_checkpoints: int = 0
    requested_time_scale: float = 1.0
    applied_time_scale: float = 1.0
    wall_fps: float = 0.0
    wall_decision_rate: float = 0.0
    sim_decision_rate: float = 0.0
    episode_started_at: float = field(default_factory=monotonic)
    parent_worker_id: str | None = None
    local_env_workers: Dict[str, str] = field(default_factory=dict)


class TrainingCoordinator:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.sessions: Dict[str, WorkerSession] = {}
        self.dashboard_clients: set[Any] = set()
        self.action_space_name = "bucket9"
        self.action_space = get_action_space(self.action_space_name)
        self.agent: PPOAgent | None = None
        self.config: Dict[str, Any] = {}
        self.track: Dict[str, Any] = {}
        self.sensor_config: Dict[str, Any] = {}
        self.next_worker_index = 1
        self.global_step = 0
        self.completed_episodes = 0
        self.finished_runs = 0
        self.updates = 0
        self.last_update_stats = {"policy_loss": 0.0, "value_loss": 0.0, "entropy": 0.0}
        self.checkpoint_path = Path(args.checkpoint_dir) / "latest.pt"
        self.checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        self.best_episode_return = float("-inf")
        self.episode_returns: deque[float] = deque(maxlen=args.history_size)
        self.best_return_history: deque[float] = deque(maxlen=args.history_size)
        self.mean_return_history: deque[float] = deque(maxlen=args.history_size)
        self.policy_loss_history: deque[float] = deque(maxlen=args.history_size)
        self.value_loss_history: deque[float] = deque(maxlen=args.history_size)
        self.entropy_history: deque[float] = deque(maxlen=args.history_size)
        self.lap_time_history: deque[float] = deque(maxlen=args.history_size)
        self.checkpoint_history: deque[float] = deque(maxlen=args.history_size)
        self.step_timestamps: deque[float] = deque(maxlen=1024)
        self.last_dashboard_push = 0.0
        self.dashboard_url = build_dashboard_url(args)
        self.current_launch_key: str | None = None
        self.force_fresh_agent_build = False

    def _normalized_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        trajectory_reference = config.get("trajectoryReference") if isinstance(config.get("trajectoryReference"), dict) else None
        progress_mode = "trajectory" if config.get("progressMode") == "trajectory" and trajectory_reference is not None else "checkpoint"
        return {
            "actionSpace": config.get("actionSpace", "bucket9"),
            "trackName": config.get("trackName", "Track"),
            "trackId": config.get("trackId"),
            "launchKey": config.get("launchKey"),
            "serverUrl": config.get("serverUrl", "ws://127.0.0.1:8765"),
            "episodeTimeoutSeconds": float(config.get("episodeTimeoutSeconds", 30.0)),
            "stallTimeoutSeconds": max(float(config.get("stallTimeoutSeconds", 6.0)), 0.0),
            "startTimeoutSeconds": float(config.get("startTimeoutSeconds", 2.5)),
            "manualFallback": bool(config.get("manualFallback", False)),
            "offTrackStepPenalty": bool(config.get("offTrackStepPenalty", True)),
            "workerCount": max(int(config.get("workerCount", 1) or 1), 1),
            "timeScale": max(float(config.get("timeScale", 1.0) or 1.0), _min_time_scale()),
            "dashboardFocus": config.get("dashboardFocus", "best") if config.get("dashboardFocus") in {"all", "best"} else "best",
            "checkpointMode": config.get("checkpointMode", "fresh") if config.get("checkpointMode") in {"fresh", "resume"} else "fresh",
            "progressMode": progress_mode,
            "trajectoryReference": trajectory_reference if progress_mode == "trajectory" else None,
        }

    def _reset_dashboard_state(self) -> None:
        self.global_step = 0
        self.completed_episodes = 0
        self.finished_runs = 0
        self.updates = 0
        self.last_update_stats = {"policy_loss": 0.0, "value_loss": 0.0, "entropy": 0.0}
        self.best_episode_return = float("-inf")
        self.episode_returns.clear()
        self.best_return_history.clear()
        self.mean_return_history.clear()
        self.policy_loss_history.clear()
        self.value_loss_history.clear()
        self.entropy_history.clear()
        self.lap_time_history.clear()
        self.checkpoint_history.clear()
        self.step_timestamps.clear()

    def _current_sessions(self) -> list[WorkerSession]:
        if not isinstance(self.current_launch_key, str) or not self.current_launch_key:
            return list(self.sessions.values())
        matched = [session for session in self.sessions.values() if session.config.get("launchKey") == self.current_launch_key]
        return matched if matched else list(self.sessions.values())

    def _maybe_reset_for_new_launch(self, session: WorkerSession) -> None:
        launch_key = session.config.get("launchKey")
        if not isinstance(launch_key, str) or not launch_key:
            return
        if launch_key == self.current_launch_key:
            return
        self._reset_dashboard_state()
        self.current_launch_key = launch_key
        self.force_fresh_agent_build = session.config.get("checkpointMode") == "fresh"
        if self.force_fresh_agent_build:
            self.agent = None
        for active_session in self.sessions.values():
            if active_session is session or active_session.config.get("launchKey") == launch_key:
                continue
            active_session.pending_rollout.clear()
            active_session.previous_state = None
            active_session.previous_observation = None
            active_session.previous_action = None
            active_session.previous_log_prob = None
            active_session.previous_value = None

    def _build_agent(self, observation_size: int) -> None:
        self.agent = PPOAgent(
            obs_dim=observation_size,
            act_dim=len(self.action_space),
            hidden_size=self.args.hidden_size,
            learning_rate=self.args.learning_rate,
            gamma=self.args.gamma,
            gae_lambda=self.args.gae_lambda,
            clip_ratio=self.args.clip_ratio,
            train_epochs=self.args.train_epochs,
            batch_size=self.args.batch_size,
            device=self.args.device,
        )
        if self.force_fresh_agent_build and self.checkpoint_path.exists():
            self.checkpoint_path.unlink(missing_ok=True)
        if not self.force_fresh_agent_build and self.checkpoint_path.exists():
            self.agent.load(str(self.checkpoint_path))
        self.force_fresh_agent_build = False

    def _update_runtime_metrics(self, session: WorkerSession, payload: Dict[str, Any]) -> None:
        runtime = payload.get("runtime")
        if not isinstance(runtime, dict):
            return
        if isinstance(runtime.get("requestedTimeScale"), (int, float)):
            session.requested_time_scale = max(float(runtime["requestedTimeScale"]), _min_time_scale())
        if isinstance(runtime.get("appliedTimeScale"), (int, float)):
            session.applied_time_scale = max(float(runtime["appliedTimeScale"]), _min_time_scale())
        if isinstance(runtime.get("wallFps"), (int, float)):
            session.wall_fps = max(float(runtime["wallFps"]), 0.0)
        if isinstance(runtime.get("wallDecisionRate"), (int, float)):
            session.wall_decision_rate = max(float(runtime["wallDecisionRate"]), 0.0)
        if isinstance(runtime.get("simDecisionRate"), (int, float)):
            session.sim_decision_rate = max(float(runtime["simDecisionRate"]), 0.0)

    def _is_stale_launch(self, session: WorkerSession) -> bool:
        session_launch = session.config.get("launchKey")
        return (
            isinstance(self.current_launch_key, str)
            and bool(self.current_launch_key)
            and isinstance(session_launch, str)
            and bool(session_launch)
            and session_launch != self.current_launch_key
        )

    def create_session(self) -> WorkerSession:
        worker_id = f"car-{self.next_worker_index:02d}"
        self.next_worker_index += 1
        session = WorkerSession(worker_id=worker_id)
        self.sessions[worker_id] = session
        return session

    def _ensure_local_env_session(self, parent_session: WorkerSession, env_key: str) -> WorkerSession:
        worker_id = parent_session.local_env_workers.get(env_key)
        session = self.sessions.get(worker_id) if worker_id is not None else None
        if session is None:
            session = self.create_session()
            session.parent_worker_id = parent_session.worker_id
            parent_session.local_env_workers[env_key] = session.worker_id
        session.config = dict(parent_session.config)
        session.track = dict(parent_session.track)
        session.sensor_config = dict(parent_session.sensor_config)
        session.requested_time_scale = parent_session.requested_time_scale
        session.applied_time_scale = parent_session.applied_time_scale
        session.wall_fps = parent_session.wall_fps
        session.wall_decision_rate = parent_session.wall_decision_rate
        session.sim_decision_rate = parent_session.sim_decision_rate
        return session

    def _drop_local_env_session(self, parent_session: WorkerSession, env_key: str) -> WorkerSession | None:
        worker_id = parent_session.local_env_workers.pop(env_key, None)
        if worker_id is None:
            return None
        return self.sessions.pop(worker_id, None)

    def _assert_compatible_run(self, config: Dict[str, Any], track: Dict[str, Any], observation_size: int) -> None:
        if self.agent is None:
            self.action_space_name = config["actionSpace"]
            self.action_space = get_action_space(self.action_space_name)
            self.config = dict(config)
            self.track = dict(track)
            self._build_agent(observation_size)
            return

        active_other_workers = sum(1 for session in self._current_sessions() if session.config) > 1
        if self.agent.obs_dim != observation_size or self.action_space_name != config["actionSpace"]:
            if active_other_workers:
                raise ValueError("All workers must share the same sensors and action space")
            self.action_space_name = config["actionSpace"]
            self.action_space = get_action_space(self.action_space_name)
            self.config = dict(config)
            self.track = dict(track)
            self._build_agent(observation_size)

        active_track_id = self.track.get("trackId") or self.config.get("trackId")
        incoming_track_id = track.get("trackId") or config.get("trackId")
        if active_other_workers and active_track_id is not None and incoming_track_id is not None and active_track_id != incoming_track_id:
            raise ValueError("All connected workers must train the same track")

        self.config.update(config)
        self.track = dict(track or self.track)
        self.sensor_config = dict(self.sensor_config or {})

    def _checkpoint_progress(self, session: WorkerSession, state: Dict[str, Any]) -> float:
        score = progress_score(
            state,
            progress_mode=session.config.get("progressMode", "checkpoint"),
            trajectory_reference=session.config.get("trajectoryReference"),
        )
        if score > session.best_progress + 0.25:
            session.best_progress = score
            session.last_progress_time = float(state.get("timeSeconds", 0.0))
        return score

    def _terminal_reason(self, session: WorkerSession, state: Dict[str, Any]) -> str | None:
        self._checkpoint_progress(session, state)
        if bool(state.get("finished")):
            return "finished"
        if float(state.get("position", {}).get("y", 0.0)) < -20.0:
            return "fell"
        if not bool(state.get("started")):
            if monotonic() - session.episode_started_at >= session.config["startTimeoutSeconds"]:
                return "did_not_start"
            return None
        if bool(state.get("started")):
            current_time = float(state.get("timeSeconds", 0.0))
            seconds_since_progress = current_time - session.last_progress_time
            if wheel_contact_count(state) == 0 and float(state.get("heightAboveGround", 0.0)) > 5.5 and seconds_since_progress >= 1.25:
                return "off_track"
            if current_time >= session.config["episodeTimeoutSeconds"]:
                return "timeout"
            stall_timeout = float(session.config.get("stallTimeoutSeconds", 0.0))
            if stall_timeout > 0.0 and seconds_since_progress >= stall_timeout:
                return "stall"
        return None

    def _terminal_bonus(self, reason: str | None, state: Dict[str, Any] | None = None) -> float:
        if reason == "finished":
            return 400.0
        if reason in {"fell", "off_track"}:
            return -25.0
        return 0.0

    def _reset_session_episode(self, session: WorkerSession, reason: str) -> None:
        _trainer_log(
            "episode_reset",
            worker_id=session.worker_id,
            reason=reason,
            episode=session.episode,
            episode_step=session.episode_step,
            total_steps=session.total_steps,
            episode_return=round(session.episode_return, 4),
            checkpoint_index=session.checkpoint_index,
            time_seconds=round(session.current_time_seconds, 4),
        )
        session.pending_reset = True
        session.episode += 1
        session.episode_step = 0
        session.episode_return = 0.0
        session.best_progress = float("-inf")
        session.last_progress_time = 0.0
        session.previous_state = None
        session.previous_observation = None
        session.previous_action = None
        session.previous_log_prob = None
        session.previous_value = None
        session.current_action_label = "idle"
        session.last_reset_reason = reason
        session.episode_started_at = monotonic()

    def _rollout_fill(self) -> int:
        return sum(len(session.pending_rollout) for session in self._current_sessions())

    def _record_episode(self, session: WorkerSession, reason: str) -> None:
        self.completed_episodes += 1
        self.best_episode_return = max(self.best_episode_return, session.episode_return)
        self.episode_returns.append(session.episode_return)
        self.best_return_history.append(self.best_episode_return if self.best_episode_return != float("-inf") else 0.0)
        mean_return = sum(self.episode_returns) / len(self.episode_returns) if self.episode_returns else 0.0
        self.mean_return_history.append(mean_return)
        self.checkpoint_history.append(max(int(session.checkpoint_index), 0))
        if reason == "finished":
            self.lap_time_history.append(max(float(session.current_time_seconds), 0.0))

    def _record_update(self) -> None:
        self.policy_loss_history.append(float(self.last_update_stats.get("policy_loss", 0.0)))
        self.value_loss_history.append(float(self.last_update_stats.get("value_loss", 0.0)))
        self.entropy_history.append(float(self.last_update_stats.get("entropy", 0.0)))

    def _steps_per_second(self) -> float:
        if len(self.step_timestamps) < 2:
            return 0.0
        elapsed = self.step_timestamps[-1] - self.step_timestamps[0]
        if elapsed <= 1e-6:
            return 0.0
        return (len(self.step_timestamps) - 1) / elapsed

    def _best_worker(self) -> WorkerSession | None:
        sessions = self._current_sessions()
        if not sessions:
            return None
        return max(
            sessions,
            key=lambda session: (
                session.best_return if session.best_return != float("-inf") else float("-inf"),
                session.episode_return,
                session.total_steps,
            ),
        )

    def _cluster_status(self) -> Dict[str, Any]:
        best_worker = self._best_worker()
        recent_mean = sum(self.episode_returns) / len(self.episode_returns) if self.episode_returns else 0.0
        cluster_sessions = self._current_sessions()
        runtime_sessions = [session for session in cluster_sessions if session.config]
        total_checkpoints = max((session.total_checkpoints for session in cluster_sessions), default=0)
        best_checkpoint = max(
            [int(value) for value in self.checkpoint_history] + [session.checkpoint_index for session in cluster_sessions] + [0]
        )
        best_lap_time = min(self.lap_time_history) if self.lap_time_history else None
        applied_scale = (
            sum(session.applied_time_scale for session in runtime_sessions) / len(runtime_sessions)
            if runtime_sessions
            else self.config.get("timeScale", 1.0)
        )
        wall_decision_rate = (
            sum(session.wall_decision_rate for session in runtime_sessions) / len(runtime_sessions)
            if runtime_sessions
            else 0.0
        )
        sim_decision_rate = (
            sum(session.sim_decision_rate for session in runtime_sessions) / len(runtime_sessions)
            if runtime_sessions
            else 0.0
        )
        return {
            "trackName": self.config.get("trackName", "Track"),
            "trackId": self.track.get("trackId") or self.config.get("trackId"),
            "actionSpace": self.action_space_name,
            "connectedWorkers": len(cluster_sessions),
            "targetWorkers": self.config.get("workerCount", len(cluster_sessions) or 1),
            "totalCheckpoints": total_checkpoints,
            "timeScale": self.config.get("timeScale", 1.0),
            "appliedTimeScale": applied_scale,
            "dashboardFocus": self.config.get("dashboardFocus", "best"),
            "globalStep": self.global_step,
            "updates": self.updates,
            "rolloutFill": self._rollout_fill(),
            "rolloutTarget": self.args.rollout_steps,
            "finishedRuns": self.finished_runs,
            "completedEpisodes": self.completed_episodes,
            "bestEpisodeReturn": self.best_episode_return if self.best_episode_return != float("-inf") else 0.0,
            "meanEpisodeReturn": recent_mean,
            "bestLapTime": best_lap_time,
            "bestCheckpoint": best_checkpoint,
            "stepsPerSecond": self._steps_per_second(),
            "wallDecisionRate": wall_decision_rate,
            "simDecisionRate": sim_decision_rate,
            "bestWorkerId": best_worker.worker_id if best_worker is not None else None,
            "dashboardUrl": self.dashboard_url,
            "policyLoss": self.last_update_stats.get("policy_loss"),
            "valueLoss": self.last_update_stats.get("value_loss"),
            "entropy": self.last_update_stats.get("entropy"),
        }

    def _worker_card(self, session: WorkerSession) -> Dict[str, Any]:
        return {
            "workerId": session.worker_id,
            "episode": session.episode,
            "episodeStep": session.episode_step,
            "totalSteps": session.total_steps,
            "episodeReturn": session.episode_return,
            "bestReturn": session.best_return if session.best_return != float("-inf") else 0.0,
            "action": session.current_action_label,
            "lastResetReason": session.last_reset_reason,
            "checkpointIndex": session.checkpoint_index,
            "totalCheckpoints": session.total_checkpoints,
            "timeSeconds": session.current_time_seconds,
            "bestProgress": session.best_progress if session.best_progress != float("-inf") else 0.0,
            "requestedTimeScale": session.requested_time_scale,
            "appliedTimeScale": session.applied_time_scale,
            "wallFps": session.wall_fps,
            "wallDecisionRate": session.wall_decision_rate,
            "simDecisionRate": session.sim_decision_rate,
        }

    def _status_payload(self, session: WorkerSession) -> Dict[str, Any]:
        payload = self._cluster_status()
        payload.update(
            {
                "trainer": "ppo",
                "workerId": session.worker_id,
                "episode": session.episode,
                "episodeStep": session.episode_step,
                "workerStep": session.total_steps,
                "episodeReturn": session.episode_return,
                "bestReturn": session.best_return if session.best_return != float("-inf") else 0.0,
                "action": session.current_action_label,
                "lastResetReason": session.last_reset_reason,
                "checkpointIndex": session.checkpoint_index,
                "totalCheckpoints": session.total_checkpoints,
                "finishedRuns": session.finished_runs,
                "workerBestProgress": session.best_progress if session.best_progress != float("-inf") else 0.0,
            }
        )
        return payload

    def _dashboard_payload(self) -> Dict[str, Any]:
        cluster = self._cluster_status()
        cluster.update(
            {
                "workers": [self._worker_card(session) for session in sorted(self._current_sessions(), key=lambda item: item.worker_id)],
                "episodeHistory": list(self.episode_returns),
                "bestHistory": list(self.best_return_history),
                "meanHistory": list(self.mean_return_history),
                "policyLossHistory": list(self.policy_loss_history),
                "valueLossHistory": list(self.value_loss_history),
                "entropyHistory": list(self.entropy_history),
                "lapTimeHistory": list(self.lap_time_history),
                "checkpointHistory": list(self.checkpoint_history),
            }
        )
        return {"type": "dashboard_status", "status": cluster}

    def _launch_action_index(self) -> int:
        for index, action in enumerate(self.action_space):
            if action.get("label") == "throttle":
                return index
        return 0

    def _select_action(self, state: Dict[str, Any], observation: list[float]) -> tuple[int, float, float]:
        if self.agent is None:
            raise RuntimeError("Trainer received action selection before agent initialization")

        if not bool(state.get("started")) and float(state.get("speedKmh", 0.0)) < 5.0:
            action_index = self._launch_action_index()
            log_prob, value = self.agent.action_log_prob_and_value(observation, action_index)
            return action_index, log_prob, value

        return self.agent.select_action(observation)

    def _flush_session_rollout(self, session: WorkerSession, bootstrap_value: float) -> None:
        if self.agent is None or not session.pending_rollout:
            return

        next_value = float(bootstrap_value)
        next_advantage = 0.0
        computed: list[tuple[PendingTransition, float, float]] = []

        for transition in reversed(session.pending_rollout):
            non_terminal = 0.0 if transition.done else 1.0
            delta = transition.reward + self.agent.gamma * next_value * non_terminal - transition.value
            advantage = delta + self.agent.gamma * self.agent.gae_lambda * non_terminal * next_advantage
            computed.append((transition, transition.value + advantage, advantage))
            next_value = transition.value
            next_advantage = advantage

        for transition, return_value, advantage in reversed(computed):
            self.agent.buffer.add(transition.observation, transition.action, transition.log_prob, return_value, advantage)

        session.pending_rollout.clear()

    async def _maybe_update(self, force: bool = False) -> None:
        if self.agent is None:
            return
        if not force and self._rollout_fill() < self.args.rollout_steps:
            return

        for session in self._current_sessions():
            if not session.pending_rollout:
                continue
            bootstrap = 0.0
            if not session.pending_reset and session.current_observation is not None:
                bootstrap = self.agent.value_only(session.current_observation)
            self._flush_session_rollout(session, bootstrap)

        if len(self.agent.buffer) == 0:
            return

        self.last_update_stats = self.agent.update()
        self.updates += 1
        self._record_update()
        if self.updates % self.args.save_every == 0:
            self.agent.save(str(self.checkpoint_path))
        await self.broadcast_dashboard(force=True)

    async def broadcast_dashboard(self, force: bool = False) -> None:
        if not self.dashboard_clients:
            return
        now = monotonic()
        if not force and now - self.last_dashboard_push < self.args.dashboard_interval:
            return
        self.last_dashboard_push = now
        payload = json.dumps(self._dashboard_payload())
        stale: list[Any] = []
        for websocket in list(self.dashboard_clients):
            try:
                await websocket.send(payload)
            except ConnectionClosed:
                stale.append(websocket)
        for websocket in stale:
            self.dashboard_clients.discard(websocket)

    async def register_dashboard(self, websocket: Any) -> None:
        self.dashboard_clients.add(websocket)
        await websocket.send(json.dumps({"type": "dashboard_hello", "dashboardUrl": self.dashboard_url}))
        await websocket.send(json.dumps(self._dashboard_payload()))

    def unregister_dashboard(self, websocket: Any) -> None:
        self.dashboard_clients.discard(websocket)

    async def unregister_worker(self, session: WorkerSession) -> None:
        if session.worker_id not in self.sessions:
            return
        child_sessions: list[WorkerSession] = []
        for env_key in list(session.local_env_workers.keys()):
            child = self._drop_local_env_session(session, env_key)
            if child is not None:
                child_sessions.append(child)
        for child in child_sessions:
            if child.pending_rollout and self.agent is not None and not self._is_stale_launch(child):
                self._flush_session_rollout(child, 0.0)
        if session.pending_rollout and self.agent is not None and not self._is_stale_launch(session):
            self._flush_session_rollout(session, 0.0)
            await self._maybe_update(force=True)
        self.sessions.pop(session.worker_id, None)
        await self.broadcast_dashboard(force=True)

    async def on_worker_hello(self, session: WorkerSession, payload: Dict[str, Any]) -> Dict[str, Any]:
        session.config = self._normalized_config(payload.get("config", {}))
        session.track = payload.get("track", {}) if isinstance(payload.get("track"), dict) else {}
        session.sensor_config = payload.get("sensorConfig", {}) if isinstance(payload.get("sensorConfig"), dict) else {}
        session.requested_time_scale = session.config.get("timeScale", 1.0)
        session.applied_time_scale = session.config.get("timeScale", 1.0)
        self._maybe_reset_for_new_launch(session)
        observation = flatten_state(payload.get("state", {}))
        self._assert_compatible_run(session.config, session.track, len(observation))
        self.config = dict(session.config)
        self.track = dict(session.track)
        self.sensor_config = dict(session.sensor_config)
        _trainer_log(
            "worker_hello",
            worker_id=session.worker_id,
            launch_key=session.config.get("launchKey"),
            track_id=session.config.get("trackId"),
            track_name=session.config.get("trackName"),
            worker_count=session.config.get("workerCount"),
            checkpoint_mode=session.config.get("checkpointMode"),
            progress_mode=session.config.get("progressMode"),
            session_id=payload.get("sessionId"),
        )
        await self.broadcast_dashboard(force=True)
        return {
            "type": "hello",
            "trainer": "ppo",
            "workerId": session.worker_id,
            "checkpointPath": str(self.checkpoint_path),
            "actionSpace": self.action_space_name,
            "dashboardUrl": self.dashboard_url,
            "rolloutSteps": self.args.rollout_steps,
        }

    def _advance_worker_state(self, session: WorkerSession, state: Dict[str, Any], runtime: Dict[str, Any] | None = None) -> Dict[str, Any]:
        if self.agent is None:
            raise RuntimeError("Trainer received state before hello")
        if self._is_stale_launch(session):
            return {
                "type": "control",
                "controls": {"up": False, "right": False, "down": False, "left": False},
                "reset": True,
                "reason": "stale_launch",
                "status": self._status_payload(session),
            }

        if isinstance(runtime, dict):
            self._update_runtime_metrics(session, {"runtime": runtime})

        observation = flatten_state(state)
        session.current_state = state
        session.current_observation = observation
        session.current_time_seconds = float(state.get("timeSeconds", 0.0))
        session.checkpoint_index = int(state.get("checkpointIndex", 0) or 0)
        session.total_checkpoints = int(state.get("totalCheckpoints", 0) or 0)

        if session.pending_reset:
            if session.current_time_seconds < 2.0 and session.checkpoint_index == 0:
                session.pending_reset = False
                session.best_progress = float("-inf")
                session.last_progress_time = 0.0
                session.episode_started_at = monotonic()
            else:
                return {
                    "type": "control",
                    "controls": {"up": False, "right": False, "down": False, "left": False},
                    "reset": True,
                    "reason": session.last_reset_reason,
                    "status": self._status_payload(session),
                }

        terminal_reason = self._terminal_reason(session, state)

        if (
            session.previous_state is not None
            and session.previous_observation is not None
            and session.previous_action is not None
            and session.previous_log_prob is not None
            and session.previous_value is not None
        ):
            reward = step_reward(
                session.previous_state,
                state,
                apply_off_track_step_penalty=bool(session.config.get("offTrackStepPenalty", True)),
                progress_mode=session.config.get("progressMode", "checkpoint"),
                trajectory_reference=session.config.get("trajectoryReference"),
            ) + self._terminal_bonus(terminal_reason, state)
            session.pending_rollout.append(
                PendingTransition(
                    observation=session.previous_observation,
                    action=session.previous_action,
                    log_prob=session.previous_log_prob,
                    value=session.previous_value,
                    reward=reward,
                    done=terminal_reason is not None,
                )
            )
            session.episode_return += reward
            session.episode_step += 1
            session.total_steps += 1
            self.global_step += 1
            self.step_timestamps.append(monotonic())

        if terminal_reason is not None:
            if terminal_reason == "finished":
                session.finished_runs += 1
                self.finished_runs += 1
            session.best_return = max(session.best_return, session.episode_return)
            self._record_episode(session, terminal_reason)
            self._reset_session_episode(session, terminal_reason)
            return {
                "type": "control",
                "controls": {"up": False, "right": False, "down": False, "left": False},
                "reset": True,
                "reason": terminal_reason,
                "status": self._status_payload(session),
            }

        action_index, log_prob, value = self._select_action(state, observation)
        session.current_action_label = str(self.action_space[action_index]["label"])
        session.previous_state = state
        session.previous_observation = observation
        session.previous_action = action_index
        session.previous_log_prob = log_prob
        session.previous_value = value

        return {
            "type": "control",
            "controls": self.action_space[action_index]["controls"],
            "reset": False,
            "status": self._status_payload(session),
        }

    async def on_worker_state(self, session: WorkerSession, payload: Dict[str, Any]) -> Dict[str, Any]:
        runtime = payload.get("runtime") if isinstance(payload.get("runtime"), dict) else None
        state = payload.get("state", {}) if isinstance(payload.get("state"), dict) else {}
        result = self._advance_worker_state(session, state, runtime)

        extra_controls: list[Dict[str, Any]] = []
        active_env_keys: set[str] = set()
        extra_states = payload.get("extraStates")
        if isinstance(extra_states, list):
            for entry in extra_states:
                if not isinstance(entry, dict):
                    continue
                env_key = entry.get("envKey")
                env_state = entry.get("state")
                if not isinstance(env_key, str) or not env_key or not isinstance(env_state, dict):
                    continue
                active_env_keys.add(env_key)
                child_session = self._ensure_local_env_session(session, env_key)
                child_result = self._advance_worker_state(child_session, env_state, runtime)
                child_result["workerId"] = child_session.worker_id
                child_result["envKey"] = env_key
                extra_controls.append(child_result)

        removed_child = False
        for env_key in list(session.local_env_workers.keys()):
            if env_key in active_env_keys:
                continue
            child = self._drop_local_env_session(session, env_key)
            if child is None:
                continue
            removed_child = True
            if child.pending_rollout and self.agent is not None and not self._is_stale_launch(child):
                self._flush_session_rollout(child, 0.0)

        await self._maybe_update()
        force_dashboard = removed_child or bool(result.get("reset")) or any(bool(item.get("reset")) for item in extra_controls)
        result["status"] = self._status_payload(session)
        for item in extra_controls:
            child_session = self.sessions.get(item.get("workerId"))
            if child_session is not None:
                item["status"] = self._status_payload(child_session)
        await self.broadcast_dashboard(force=force_dashboard)
        result["extraControls"] = extra_controls
        return result


class DashboardRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, directory: str, **kwargs: Any) -> None:
        super().__init__(*args, directory=directory, **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        return


def start_dashboard_server(args: argparse.Namespace) -> ThreadingHTTPServer:
    dashboard_dir = Path(__file__).resolve().parent.parent

    def handler(*handler_args: Any, **handler_kwargs: Any) -> DashboardRequestHandler:
        return DashboardRequestHandler(*handler_args, directory=str(dashboard_dir), **handler_kwargs)

    server = ThreadingHTTPServer((args.dashboard_host, args.dashboard_port), handler)
    thread = threading.Thread(target=server.serve_forever, name="polytrack-dashboard", daemon=True)
    thread.start()
    return server


async def connection_handler(websocket: Any, coordinator: TrainingCoordinator) -> None:
    session: WorkerSession | None = None
    is_dashboard = False
    try:
        async for message in websocket:
            payload = json.loads(message)
            if not isinstance(payload, dict):
                continue
            message_type = payload.get("type")
            if message_type == "dashboard_hello":
                is_dashboard = True
                await coordinator.register_dashboard(websocket)
            elif message_type == "hello":
                if session is None:
                    session = coordinator.create_session()
                try:
                    await websocket.send(json.dumps(await coordinator.on_worker_hello(session, payload)))
                except ValueError as error:
                    _trainer_log("worker_hello_error", worker_id=session.worker_id, error=str(error))
                    await websocket.send(json.dumps({"type": "error", "message": str(error)}))
            elif message_type == "state":
                if session is None:
                    await websocket.send(json.dumps({"type": "error", "message": "State received before hello"}))
                    continue
                try:
                    await websocket.send(json.dumps(await coordinator.on_worker_state(session, payload)))
                except ValueError as error:
                    _trainer_log("worker_state_error", worker_id=session.worker_id, error=str(error))
                    await websocket.send(json.dumps({"type": "error", "message": str(error)}))
            elif message_type == "event":
                event_name = payload.get("event")
                if event_name == "browser_debug":
                    entry = payload.get("payload", {})
                    if isinstance(entry, dict):
                        _trainer_log(
                            "browser_debug",
                            worker_id=session.worker_id if session is not None else None,
                            browser_event=entry.get("event"),
                            at=entry.get("at"),
                            href=entry.get("href"),
                            payload=entry.get("payload"),
                        )
                    else:
                        _trainer_log("browser_debug", worker_id=session.worker_id if session is not None else None, payload=entry)
                elif event_name == "client_reset":
                    _trainer_log(
                        "client_reset",
                        worker_id=session.worker_id if session is not None else None,
                        reason=payload.get("reason"),
                    )
                else:
                    _trainer_log(
                        "client_event",
                        worker_id=session.worker_id if session is not None else None,
                        event=event_name,
                        payload=payload,
                    )
                continue
            else:
                await websocket.send(json.dumps({"type": "error", "message": f"Unknown message type: {message_type}"}))
    finally:
        if is_dashboard:
            coordinator.unregister_dashboard(websocket)
        if session is not None:
            await coordinator.unregister_worker(session)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="PolyTrack shared PPO trainer")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--dashboard-host", default="127.0.0.1")
    parser.add_argument("--dashboard-port", type=int, default=8766)
    parser.add_argument("--dashboard-interval", type=float, default=0.2)
    parser.add_argument("--history-size", type=int, default=240)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--hidden-size", type=int, default=128)
    parser.add_argument("--gamma", type=float, default=0.99)
    parser.add_argument("--gae-lambda", type=float, default=0.95)
    parser.add_argument("--clip-ratio", type=float, default=0.2)
    parser.add_argument("--train-epochs", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--rollout-steps", type=int, default=1024)
    parser.add_argument("--save-every", type=int, default=5)
    parser.add_argument("--checkpoint-dir", default="training/checkpoints")
    return parser


async def serve(args: argparse.Namespace) -> None:
    coordinator = TrainingCoordinator(args)
    dashboard_server = start_dashboard_server(args)
    try:
        async with websockets.serve(lambda ws: connection_handler(ws, coordinator), args.host, args.port, max_size=2**22):
            print(f"PolyTrack trainer listening on ws://{_safe_host(args.host)}:{args.port}")
            print(f"PolyTrack dashboard available at {coordinator.dashboard_url}")
            await asyncio.Future()
    finally:
        dashboard_server.shutdown()
        dashboard_server.server_close()


def main() -> None:
    args = build_parser().parse_args()
    try:
        asyncio.run(serve(args))
    except OSError as error:
        if error.errno == errno.EADDRINUSE:
            message = (
                f"Training server could not start because port {args.port} or dashboard port {args.dashboard_port} "
                "is already in use. Stop the old trainer first, or run with different --port/--dashboard-port values."
            )
            raise SystemExit(message) from None
        raise


if __name__ == "__main__":
    main()
