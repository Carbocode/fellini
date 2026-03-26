from __future__ import annotations

import argparse
import json
from pathlib import Path

import uvicorn

from fellini.domain.models import JobRequest, RunProfile
from fellini.log import configure_logging, get_logger
from fellini.services.job_manager import JobManager
from fellini.settings import load_settings

logger = get_logger(__name__)


def main() -> None:
    parser = argparse.ArgumentParser(prog="fellini")
    parser.add_argument("--config", type=Path, default=None, help="Optional YAML config file.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve_parser = subparsers.add_parser("serve", help="Start the local web UI.")
    serve_parser.add_argument("--host", default=None)
    serve_parser.add_argument("--port", type=int, default=None)

    run_parser = subparsers.add_parser("run", help="Run the pipeline once from the CLI.")
    run_parser.add_argument("inputs", nargs="+", type=Path)
    run_parser.add_argument("--title", default="CLI project")
    run_parser.add_argument(
        "--profile", choices=[profile.value for profile in RunProfile], default="balanced"
    )
    run_parser.add_argument("--language", default="it")

    args = parser.parse_args()
    settings = load_settings(args.config)
    configure_logging(settings.log_level)
    logger.info(
        "cli.start command=%s config=%s workspace_root=%s",
        args.command,
        args.config,
        settings.workspace_root,
    )

    if args.command == "serve":
        logger.info(
            "cli.serve host=%s port=%s",
            args.host or settings.host,
            args.port or settings.port,
        )
        uvicorn.run(
            "fellini.app:create_app",
            factory=True,
            host=args.host or settings.host,
            port=args.port or settings.port,
            reload=False,
        )
        return

    if args.command == "run":
        manager = JobManager(settings)
        request = JobRequest.with_profile(
            title=args.title,
            profile=RunProfile(args.profile),
            language=args.language,
        )
        logger.info(
            "cli.run title=%s profile=%s language=%s inputs=%s",
            args.title,
            args.profile,
            args.language,
            [str(path.resolve()) for path in args.inputs],
        )
        snapshot = manager.create_from_paths(request, [path.resolve() for path in args.inputs])
        result = manager.run_sync(snapshot.id)
        logger.info(
            "cli.run.completed job_id=%s status=%s outputs=%s",
            result.id,
            result.status.value,
            result.outputs,
        )
        print(json.dumps(result.model_dump(mode="json"), indent=2))
