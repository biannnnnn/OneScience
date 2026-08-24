"""Calibrated acceptance prediction built on frozen OneScience reviews."""

from .model import AcceptancePredictor, ModelError, train_model

__all__ = ["AcceptancePredictor", "ModelError", "train_model"]
__version__ = "0.1.0"
