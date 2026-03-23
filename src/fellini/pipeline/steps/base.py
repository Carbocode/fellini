from __future__ import annotations

from abc import ABC, abstractmethod

from fellini.domain.models import StepName
from fellini.pipeline.context import PipelineContext


class PipelineStep(ABC):
    name: StepName
    description: str

    @abstractmethod
    def run(self, context: PipelineContext) -> list[str]:
        raise NotImplementedError
