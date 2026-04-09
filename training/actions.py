from __future__ import annotations

from typing import Dict, List


ACTION_SPACES: Dict[str, List[Dict[str, object]]] = {
    "bucket7": [
        {"label": "coast", "controls": {"up": False, "right": False, "down": False, "left": False}},
        {"label": "throttle", "controls": {"up": True, "right": False, "down": False, "left": False}},
        {"label": "throttle_left", "controls": {"up": True, "right": False, "down": False, "left": True}},
        {"label": "throttle_right", "controls": {"up": True, "right": True, "down": False, "left": False}},
        {"label": "brake", "controls": {"up": False, "right": False, "down": True, "left": False}},
        {"label": "brake_left", "controls": {"up": False, "right": False, "down": True, "left": True}},
        {"label": "brake_right", "controls": {"up": False, "right": True, "down": True, "left": False}},
    ],
    "bucket9": [
        {"label": "coast", "controls": {"up": False, "right": False, "down": False, "left": False}},
        {"label": "throttle", "controls": {"up": True, "right": False, "down": False, "left": False}},
        {"label": "throttle_left", "controls": {"up": True, "right": False, "down": False, "left": True}},
        {"label": "throttle_right", "controls": {"up": True, "right": True, "down": False, "left": False}},
        {"label": "brake", "controls": {"up": False, "right": False, "down": True, "left": False}},
        {"label": "brake_left", "controls": {"up": False, "right": False, "down": True, "left": True}},
        {"label": "brake_right", "controls": {"up": False, "right": True, "down": True, "left": False}},
        {"label": "left", "controls": {"up": False, "right": False, "down": False, "left": True}},
        {"label": "right", "controls": {"up": False, "right": True, "down": False, "left": False}},
    ],
}


def get_action_space(name: str) -> List[Dict[str, object]]:
    return ACTION_SPACES.get(name, ACTION_SPACES["bucket9"])
