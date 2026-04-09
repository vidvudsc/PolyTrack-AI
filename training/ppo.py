from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List

import torch
from torch import nn
from torch.distributions import Categorical


class ActorCritic(nn.Module):
    def __init__(self, obs_dim: int, act_dim: int, hidden_size: int) -> None:
        super().__init__()
        self.policy = nn.Sequential(
            nn.Linear(obs_dim, hidden_size),
            nn.Tanh(),
            nn.Linear(hidden_size, hidden_size),
            nn.Tanh(),
            nn.Linear(hidden_size, act_dim),
        )
        self.value = nn.Sequential(
            nn.Linear(obs_dim, hidden_size),
            nn.Tanh(),
            nn.Linear(hidden_size, hidden_size),
            nn.Tanh(),
            nn.Linear(hidden_size, 1),
        )

    def forward(self, observations: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        return self.policy(observations), self.value(observations).squeeze(-1)


@dataclass
class RolloutBuffer:
    observations: List[List[float]] = field(default_factory=list)
    actions: List[int] = field(default_factory=list)
    log_probs: List[float] = field(default_factory=list)
    returns: List[float] = field(default_factory=list)
    advantages: List[float] = field(default_factory=list)

    def clear(self) -> None:
        self.observations.clear()
        self.actions.clear()
        self.log_probs.clear()
        self.returns.clear()
        self.advantages.clear()

    def add(self, observation: List[float], action: int, log_prob: float, return_value: float, advantage: float) -> None:
        self.observations.append(list(observation))
        self.actions.append(int(action))
        self.log_probs.append(float(log_prob))
        self.returns.append(float(return_value))
        self.advantages.append(float(advantage))

    def __len__(self) -> int:
        return len(self.actions)


class PPOAgent:
    def __init__(
        self,
        obs_dim: int,
        act_dim: int,
        hidden_size: int = 128,
        learning_rate: float = 3e-4,
        gamma: float = 0.99,
        gae_lambda: float = 0.95,
        clip_ratio: float = 0.2,
        train_epochs: int = 8,
        batch_size: int = 256,
        device: str = "cpu",
    ) -> None:
        self.obs_dim = obs_dim
        self.act_dim = act_dim
        self.gamma = gamma
        self.gae_lambda = gae_lambda
        self.clip_ratio = clip_ratio
        self.train_epochs = train_epochs
        self.batch_size = batch_size
        self.device = torch.device(device)
        self.model = ActorCritic(obs_dim, act_dim, hidden_size).to(self.device)
        self.optimizer = torch.optim.Adam(self.model.parameters(), lr=learning_rate)
        self.buffer = RolloutBuffer()

    def select_action(self, observation: List[float]) -> tuple[int, float, float]:
        obs_tensor = torch.tensor(observation, dtype=torch.float32, device=self.device).unsqueeze(0)
        with torch.no_grad():
            logits, value = self.model(obs_tensor)
            dist = Categorical(logits=logits)
            action = dist.sample()
            log_prob = dist.log_prob(action)
        return int(action.item()), float(log_prob.item()), float(value.item())

    def value_only(self, observation: List[float]) -> float:
        obs_tensor = torch.tensor(observation, dtype=torch.float32, device=self.device).unsqueeze(0)
        with torch.no_grad():
            _, value = self.model(obs_tensor)
        return float(value.item())

    def action_log_prob_and_value(self, observation: List[float], action_index: int) -> tuple[float, float]:
        obs_tensor = torch.tensor(observation, dtype=torch.float32, device=self.device).unsqueeze(0)
        action_tensor = torch.tensor([action_index], dtype=torch.int64, device=self.device)
        with torch.no_grad():
            logits, value = self.model(obs_tensor)
            distribution = Categorical(logits=logits)
            log_prob = distribution.log_prob(action_tensor)
        return float(log_prob.item()), float(value.item())

    def update(self) -> Dict[str, float]:
        if len(self.buffer) == 0:
            return {"policy_loss": 0.0, "value_loss": 0.0, "entropy": 0.0}

        observations = torch.tensor(self.buffer.observations, dtype=torch.float32, device=self.device)
        actions = torch.tensor(self.buffer.actions, dtype=torch.int64, device=self.device)
        old_log_probs = torch.tensor(self.buffer.log_probs, dtype=torch.float32, device=self.device)
        returns = torch.tensor(self.buffer.returns, dtype=torch.float32, device=self.device)
        advantages = torch.tensor(self.buffer.advantages, dtype=torch.float32, device=self.device)
        advantages = (advantages - advantages.mean()) / (advantages.std(unbiased=False) + 1e-8)

        total_policy_loss = 0.0
        total_value_loss = 0.0
        total_entropy = 0.0
        batches = 0
        total_samples = observations.shape[0]

        for _ in range(self.train_epochs):
            permutation = torch.randperm(total_samples, device=self.device)
            for start in range(0, total_samples, self.batch_size):
                batch_indices = permutation[start : start + self.batch_size]
                batch_obs = observations[batch_indices]
                batch_actions = actions[batch_indices]
                batch_old_log_probs = old_log_probs[batch_indices]
                batch_returns = returns[batch_indices]
                batch_advantages = advantages[batch_indices]

                logits, values_pred = self.model(batch_obs)
                distribution = Categorical(logits=logits)
                log_probs = distribution.log_prob(batch_actions)
                entropy = distribution.entropy().mean()
                ratio = torch.exp(log_probs - batch_old_log_probs)
                unclipped = ratio * batch_advantages
                clipped = torch.clamp(ratio, 1.0 - self.clip_ratio, 1.0 + self.clip_ratio) * batch_advantages
                policy_loss = -torch.min(unclipped, clipped).mean()
                value_loss = 0.5 * (batch_returns - values_pred).pow(2).mean()
                loss = policy_loss + value_loss * 0.5 - entropy * 0.01

                self.optimizer.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)
                self.optimizer.step()

                total_policy_loss += float(policy_loss.item())
                total_value_loss += float(value_loss.item())
                total_entropy += float(entropy.item())
                batches += 1

        self.buffer.clear()
        divisor = max(batches, 1)
        return {
            "policy_loss": total_policy_loss / divisor,
            "value_loss": total_value_loss / divisor,
            "entropy": total_entropy / divisor,
        }

    def save(self, path: str) -> None:
        torch.save(
            {
                "obs_dim": self.obs_dim,
                "act_dim": self.act_dim,
                "state_dict": self.model.state_dict(),
            },
            path,
        )

    def load(self, path: str) -> None:
        payload = torch.load(path, map_location=self.device)
        if payload.get("obs_dim") != self.obs_dim or payload.get("act_dim") != self.act_dim:
            return
        self.model.load_state_dict(payload["state_dict"])
