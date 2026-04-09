from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _avg_detector_center(detectors: Iterable[Dict[str, object]]) -> Dict[str, float] | None:
    points = [detector.get("center") for detector in detectors if isinstance(detector, dict) and isinstance(detector.get("center"), dict)]
    if not points:
        return None
    count = float(len(points))
    return {
        "x": sum(float(point.get("x", 0.0)) for point in points) / count,
        "y": sum(float(point.get("y", 0.0)) for point in points) / count,
        "z": sum(float(point.get("z", 0.0)) for point in points) / count,
    }


def _quat_inverse(quat: Dict[str, float]) -> Dict[str, float]:
    return {
        "x": -float(quat.get("x", 0.0)),
        "y": -float(quat.get("y", 0.0)),
        "z": -float(quat.get("z", 0.0)),
        "w": float(quat.get("w", 1.0)),
    }


def _rotate_vector(vector: Dict[str, float], quat: Dict[str, float]) -> Dict[str, float]:
    vx = float(vector.get("x", 0.0))
    vy = float(vector.get("y", 0.0))
    vz = float(vector.get("z", 0.0))
    qx = float(quat.get("x", 0.0))
    qy = float(quat.get("y", 0.0))
    qz = float(quat.get("z", 0.0))
    qw = float(quat.get("w", 1.0))
    ix = qw * vx + qy * vz - qz * vy
    iy = qw * vy + qz * vx - qx * vz
    iz = qw * vz + qx * vy - qy * vx
    iw = -qx * vx - qy * vy - qz * vz
    return {
        "x": ix * qw + iw * -qx + iy * -qz - iz * -qy,
        "y": iy * qw + iw * -qy + iz * -qx - ix * -qz,
        "z": iz * qw + iw * -qz + ix * -qy - iy * -qx,
    }


def wheel_contact_count(state: Dict[str, object]) -> int:
    wheel_state = state.get("wheelState")
    if not isinstance(wheel_state, list):
        return 0
    return sum(1 for wheel in wheel_state[:4] if isinstance(wheel, dict) and bool(wheel.get("inContact")))


def _target_distance(state: Dict[str, object]) -> float | None:
    distance_to_checkpoint = state.get("distanceToCurrentCheckpoint")
    if isinstance(distance_to_checkpoint, (int, float)):
        return float(distance_to_checkpoint)
    distance_to_finish = state.get("distanceToFinish")
    if isinstance(distance_to_finish, (int, float)):
        return float(distance_to_finish)
    return None


def _checkpoint_delta(previous_state: Dict[str, object], current_state: Dict[str, object]) -> float:
    return max(float(current_state.get("checkpointIndex", 0.0)) - float(previous_state.get("checkpointIndex", 0.0)), 0.0)


def _distance_gain(previous_state: Dict[str, object], current_state: Dict[str, object]) -> float:
    previous_distance = _target_distance(previous_state)
    current_distance = _target_distance(current_state)
    if previous_distance is None or current_distance is None:
        return 0.0
    return previous_distance - current_distance


def _trajectory_points(reference: Dict[str, Any] | None) -> List[Dict[str, float]]:
    if not isinstance(reference, dict):
        return []
    points = reference.get("points")
    if not isinstance(points, list):
        return []
    normalized: List[Dict[str, float]] = []
    last_progress = 0.0
    for point in points:
        if not isinstance(point, dict):
            continue
        x = float(point.get("x", 0.0))
        y = float(point.get("y", 0.0))
        z = float(point.get("z", 0.0))
        progress = float(point.get("progress", last_progress))
        progress = max(progress, last_progress)
        normalized.append({
            "x": x,
            "y": y,
            "z": z,
            "progress": progress,
        })
        last_progress = progress
    return normalized


def trajectory_progress(state: Dict[str, object], reference: Dict[str, Any] | None) -> Dict[str, float] | None:
    points = _trajectory_points(reference)
    if len(points) < 2:
        return None

    position = state.get("position") if isinstance(state.get("position"), dict) else {"x": 0.0, "y": 0.0, "z": 0.0}
    px = float(position.get("x", 0.0))
    py = float(position.get("y", 0.0))
    pz = float(position.get("z", 0.0))
    best_distance_sq = float("inf")
    best_progress = 0.0

    for index in range(len(points) - 1):
        start = points[index]
        end = points[index + 1]
        dx = float(end["x"]) - float(start["x"])
        dy = float(end["y"]) - float(start["y"])
        dz = float(end["z"]) - float(start["z"])
        horizontal_length_sq = dx * dx + dz * dz
        if horizontal_length_sq <= 1e-6:
            projected_x = float(start["x"])
            projected_y = float(start["y"])
            projected_z = float(start["z"])
            alpha = 0.0
        else:
            alpha = clamp(((px - float(start["x"])) * dx + (pz - float(start["z"])) * dz) / horizontal_length_sq, 0.0, 1.0)
            projected_x = float(start["x"]) + dx * alpha
            projected_y = float(start["y"]) + dy * alpha
            projected_z = float(start["z"]) + dz * alpha
        distance_sq = (
            (px - projected_x) * (px - projected_x)
            + (pz - projected_z) * (pz - projected_z)
            + (py - projected_y) * (py - projected_y) * 0.1
        )
        progress = float(start["progress"]) + (float(end["progress"]) - float(start["progress"])) * alpha
        if distance_sq + 1e-6 < best_distance_sq or (abs(distance_sq - best_distance_sq) <= 1e-6 and progress > best_progress):
            best_distance_sq = distance_sq
            best_progress = progress

    total_progress = max(float(points[-1]["progress"]), 1e-6)
    return {
        "progress": best_progress,
        "distance": math.sqrt(max(best_distance_sq, 0.0)),
        "completion": clamp(best_progress / total_progress, 0.0, 1.5),
        "total": total_progress,
    }


def _trajectory_gain(previous_state: Dict[str, object], current_state: Dict[str, object], reference: Dict[str, Any] | None) -> float:
    previous_progress = trajectory_progress(previous_state, reference)
    current_progress = trajectory_progress(current_state, reference)
    if previous_progress is None or current_progress is None:
        return 0.0
    return float(current_progress["progress"]) - float(previous_progress["progress"])


def _local_velocity(state: Dict[str, object]) -> Dict[str, float]:
    quaternion = state.get("quaternion") if isinstance(state.get("quaternion"), dict) else {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0}
    linear_velocity = state.get("linearVelocity") if isinstance(state.get("linearVelocity"), dict) else {"x": 0.0, "y": 0.0, "z": 0.0}
    return _rotate_vector(linear_velocity, _quat_inverse(quaternion))


def _local_target(state: Dict[str, object]) -> Dict[str, float]:
    quaternion = state.get("quaternion") if isinstance(state.get("quaternion"), dict) else {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0}
    position = state.get("position") if isinstance(state.get("position"), dict) else {"x": 0.0, "y": 0.0, "z": 0.0}
    target = _avg_detector_center(state.get("nextCheckpointDetectors") or [])
    if target is None:
        target = _avg_detector_center(state.get("finishDetectors") or [])
    if target is None:
        return {"x": 0.0, "y": 0.0, "z": 0.0}
    world_target = {
        "x": float(target["x"]) - float(position.get("x", 0.0)),
        "y": float(target["y"]) - float(position.get("y", 0.0)),
        "z": float(target["z"]) - float(position.get("z", 0.0)),
    }
    return _rotate_vector(world_target, _quat_inverse(quaternion))


def _nearest_detector(state: Dict[str, object]) -> Dict[str, object] | None:
    detectors = state.get("nextCheckpointDetectors")
    if not isinstance(detectors, list) or not detectors:
        detectors = state.get("finishDetectors")
    if not isinstance(detectors, list) or not detectors:
        return None
    position = state.get("position") if isinstance(state.get("position"), dict) else {"x": 0.0, "y": 0.0, "z": 0.0}

    def detector_distance_sq(detector: Dict[str, object]) -> float:
        center = detector.get("center") if isinstance(detector.get("center"), dict) else {"x": 0.0, "y": 0.0, "z": 0.0}
        dx = float(center.get("x", 0.0)) - float(position.get("x", 0.0))
        dz = float(center.get("z", 0.0)) - float(position.get("z", 0.0))
        return dx * dx + dz * dz

    valid = [detector for detector in detectors if isinstance(detector, dict) and isinstance(detector.get("center"), dict)]
    if not valid:
        return None
    return min(valid, key=detector_distance_sq)


def lane_features(state: Dict[str, object]) -> tuple[float, float]:
    detector = _nearest_detector(state)
    if detector is None:
        return 0.0, 0.0

    center = detector.get("center") if isinstance(detector.get("center"), dict) else {"x": 0.0, "y": 0.0, "z": 0.0}
    size = detector.get("size") if isinstance(detector.get("size"), dict) else {"x": 0.0, "y": 0.0, "z": 0.0}
    position = state.get("position") if isinstance(state.get("position"), dict) else {"x": 0.0, "y": 0.0, "z": 0.0}

    size_x = abs(float(size.get("x", 0.0)))
    size_z = abs(float(size.get("z", 0.0)))
    width_uses_x = size_x >= size_z
    half_width = max((size_x if width_uses_x else size_z) * 0.5, 1.0)
    lane_offset = (
        float(position.get("x", 0.0)) - float(center.get("x", 0.0))
        if width_uses_x
        else float(position.get("z", 0.0)) - float(center.get("z", 0.0))
    ) / half_width

    quaternion = state.get("quaternion") if isinstance(state.get("quaternion"), dict) else {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0}
    forward = _rotate_vector({"x": 0.0, "y": 0.0, "z": 1.0}, quaternion)
    gate_alignment = abs(float(forward["z"] if width_uses_x else forward["x"]))
    return lane_offset, clamp(gate_alignment, 0.0, 1.0)


def target_heading_features(state: Dict[str, object]) -> tuple[float, float]:
    local_target = _local_target(state)
    horizontal_distance = math.hypot(float(local_target["x"]), float(local_target["z"]))
    if horizontal_distance <= 1e-6:
        return 1.0, 0.0
    forward_alignment = clamp(float(local_target["z"]) / horizontal_distance, -1.0, 1.0)
    lateral_offset = clamp(abs(float(local_target["x"])) / horizontal_distance, 0.0, 2.0)
    return forward_alignment, lateral_offset


def off_track_penalty(
    previous_state: Dict[str, object],
    current_state: Dict[str, object],
    progress_mode: str = "checkpoint",
    trajectory_reference: Dict[str, Any] | None = None,
) -> float:
    contacts = wheel_contact_count(current_state)
    height = float(current_state.get("heightAboveGround", 0.0))
    checkpoint_delta = _checkpoint_delta(previous_state, current_state)
    distance_gain = (
        _trajectory_gain(previous_state, current_state, trajectory_reference)
        if progress_mode == "trajectory"
        else _distance_gain(previous_state, current_state)
    )
    forward_speed = max(_local_velocity(current_state)["z"], 0.0)

    if contacts >= 2 and height < 1.5:
        return 0.0

    if contacts == 0:
        penalty = 0.08 + max(height - 1.0, 0.0) * 0.10
        if checkpoint_delta <= 0.0:
            penalty += 0.12
        if distance_gain <= 0.5:
            penalty += 0.08
        if height > 4.0:
            penalty += 0.20
        if checkpoint_delta > 0.0 or distance_gain > 4.0 or (forward_speed > 25.0 and height < 3.0):
            penalty *= 0.4
        return min(penalty, 1.4)

    if contacts == 1 and height > 1.5:
        penalty = 0.03 + max(height - 1.5, 0.0) * 0.04
        if distance_gain > 3.0:
            penalty *= 0.5
        return min(penalty, 0.45)

    return 0.0


def on_track_reward(current_state: Dict[str, object]) -> float:
    contacts = wheel_contact_count(current_state)
    height = float(current_state.get("heightAboveGround", 0.0))
    if contacts >= 3 and height < 1.2:
        return 0.05
    if contacts >= 2 and height < 1.5:
        return 0.03
    if contacts >= 1 and height < 1.2:
        return 0.01
    return 0.0


def progress_score(state: Dict[str, object], progress_mode: str = "checkpoint", trajectory_reference: Dict[str, Any] | None = None) -> float:
    if progress_mode == "trajectory":
        info = trajectory_progress(state, trajectory_reference)
        if info is not None:
            score = float(info["progress"])
            if bool(state.get("finished")):
                score += float(info["total"]) + 500.0
            return score
    checkpoint_index = float(state.get("checkpointIndex", 0.0))
    total_checkpoints = float(max(int(state.get("totalCheckpoints", 0) or 0), 1))
    score = checkpoint_index * 1000.0
    distance_to_checkpoint = state.get("distanceToCurrentCheckpoint")
    distance_to_finish = state.get("distanceToFinish")
    if isinstance(distance_to_checkpoint, (int, float)):
        score += max(0.0, 300.0 - min(float(distance_to_checkpoint), 300.0))
    elif isinstance(distance_to_finish, (int, float)):
        score += total_checkpoints * 1000.0 + max(0.0, 300.0 - min(float(distance_to_finish), 300.0))
    if bool(state.get("finished")):
        score += total_checkpoints * 1000.0 + 500.0
    return score


def collision_penalty(state: Dict[str, object]) -> float:
    impulses = state.get("collisionImpulses")
    if not isinstance(impulses, list):
        return 0.0
    return sum(max(float(impulse) - 4.0, 0.0) for impulse in impulses[:12])


def flatten_state(state: Dict[str, object]) -> List[float]:
    quaternion = state.get("quaternion") if isinstance(state.get("quaternion"), dict) else {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0}
    local_velocity = _rotate_vector(
        state.get("linearVelocity") if isinstance(state.get("linearVelocity"), dict) else {"x": 0.0, "y": 0.0, "z": 0.0},
        _quat_inverse(quaternion),
    )
    local_target = _local_target(state)
    sensors = state.get("sensors") if isinstance(state.get("sensors"), list) else []
    wheel_state = state.get("wheelState") if isinstance(state.get("wheelState"), list) else []
    sensor_features = [float(clamp(sensor.get("normalizedDistance", 1.0), 0.0, 1.0)) for sensor in sensors][::-1]
    wheel_contacts = [1.0 if bool(wheel.get("inContact")) else 0.0 for wheel in wheel_state[:4]]
    wheel_skid = [clamp(float(wheel.get("skidInfo", 0.0)), 0.0, 1.5) / 1.5 for wheel in wheel_state[:4]]
    distance_to_checkpoint = state.get("distanceToCurrentCheckpoint")
    distance_to_finish = state.get("distanceToFinish")
    checkpoint_distance = float(distance_to_checkpoint) if isinstance(distance_to_checkpoint, (int, float)) else 0.0
    finish_distance = float(distance_to_finish) if isinstance(distance_to_finish, (int, float)) else 0.0
    lane_offset, gate_alignment = lane_features(state)
    mirrored_lane_offset = -lane_offset
    features: List[float] = []
    features.extend(sensor_features)
    features.extend(
        [
            clamp(float(state.get("speedKmh", 0.0)) / 300.0, -2.0, 2.0),
            clamp(-local_velocity["x"] / 120.0, -2.0, 2.0),
            clamp(local_velocity["y"] / 80.0, -2.0, 2.0),
            clamp(local_velocity["z"] / 120.0, -2.0, 2.0),
            clamp(-local_target["x"] / 160.0, -2.0, 2.0),
            clamp(local_target["y"] / 80.0, -2.0, 2.0),
            clamp(local_target["z"] / 160.0, -2.0, 2.0),
            clamp(float(state.get("heightAboveGround", 0.0)) / 8.0, 0.0, 2.0),
            clamp(checkpoint_distance / 250.0, 0.0, 2.0),
            clamp(finish_distance / 350.0, 0.0, 2.0),
            float(state.get("checkpointIndex", 0.0)) / max(float(state.get("totalCheckpoints", 1.0) or 1.0), 1.0),
            clamp(mirrored_lane_offset, -2.0, 2.0),
            clamp(abs(mirrored_lane_offset), 0.0, 2.0),
            gate_alignment,
            1.0 if bool(state.get("started")) else 0.0,
            1.0 if bool(state.get("finished")) else 0.0,
        ]
    )
    features.extend(wheel_contacts)
    features.extend(wheel_skid)
    return features


def step_reward(
    previous_state: Dict[str, object],
    current_state: Dict[str, object],
    apply_off_track_step_penalty: bool = True,
    progress_mode: str = "checkpoint",
    trajectory_reference: Dict[str, Any] | None = None,
) -> float:
    checkpoint_delta = _checkpoint_delta(previous_state, current_state)
    raw_progress_gain = (
        _trajectory_gain(previous_state, current_state, trajectory_reference)
        if progress_mode == "trajectory"
        else _distance_gain(previous_state, current_state)
    )
    distance_gain = clamp(raw_progress_gain, 0.0, 12.0)
    progress_reward = distance_gain * 0.2
    checkpoint_reward = checkpoint_delta * 25.0
    off_track_step_penalty = (
        off_track_penalty(previous_state, current_state, progress_mode=progress_mode, trajectory_reference=trajectory_reference)
        if apply_off_track_step_penalty
        else 0.0
    )
    time_penalty = 0.01
    return progress_reward + checkpoint_reward - off_track_step_penalty - time_penalty
