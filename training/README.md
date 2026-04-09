# Training

This trainer keeps the game runtime in the browser and runs the learning loop in Python with PyTorch.

## Quick Start

1. Install the Python dependencies:

```bash
python -m pip install -r training/requirements.txt
```

2. Start the trainer server:

```bash
python -m training
```

3. Open the dashboard URL printed by the trainer, or just let the game open it for you.

4. Open the game, choose `Training` from the main menu, pick a track and settings, then start the session.

## What Changed

- One shared PPO learner trains across multiple browser workers in parallel.
- A separate dashboard shows aggregate progress, charts, rollout fill, throughput, and worker cards.
- The current game tab stays as the live worker view while the extra workers run as cloned training envs in the same browser session.

## Defaults

- Trainer websocket: `ws://127.0.0.1:8765`
- Dashboard: `http://127.0.0.1:8766/training/dashboard/index.html`
- Action space: discrete bucket controls
- Worker count: `4`
- Time scale: `3x`
