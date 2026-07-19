from __future__ import annotations

import re
import unittest
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PLUGIN_ROOT.parent
MAX_LLM_DESCRIPTION_LENGTH = 30


def _inline_yaml_values(text: str, key: str) -> list[str]:
    # These tests intentionally use a tiny parser to avoid adding PyYAML just
    # for controlled Dify YAML fixtures; block scalars are rejected explicitly.
    values: list[str] = []
    pattern = re.compile(rf"^\s*{re.escape(key)}:\s*(.+?)\s*$")
    for line in text.splitlines():
        match = pattern.match(line)
        if not match:
            continue
        value = match.group(1).strip()
        if value in {"|", ">", "|-", ">-", "|+", ">+"}:
            raise AssertionError(f"{key} must stay inline for prompt-budget tests")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values.append(value)
    return values


def _parameter_blocks(text: str) -> dict[str, str]:
    # This covers the simple `parameters: - name: ...` shape used by Dify tools.
    blocks: dict[str, str] = {}
    for block in re.split(r"\n\s*-\s+name:\s+", f"\n{text}")[1:]:
        name, _, rest = block.partition("\n")
        blocks[name.strip()] = rest
    return blocks


class PluginManifestTest(unittest.TestCase):
    def test_manifest_references_provider_yaml(self) -> None:
        manifest = (PLUGIN_ROOT / "manifest.yaml").read_text(encoding="utf-8")

        self.assertIn("provider/tdai_memory.yaml", manifest)
        self.assertTrue((PLUGIN_ROOT / "provider" / "tdai_memory.yaml").is_file())

    def test_provider_and_tool_yaml_sources_exist(self) -> None:
        provider_yaml = (PLUGIN_ROOT / "provider" / "tdai_memory.yaml").read_text(encoding="utf-8")
        self.assertIn("source: provider/tdai_memory.py", provider_yaml)
        self.assertTrue((PLUGIN_ROOT / "provider" / "tdai_memory.py").is_file())

        tool_paths = re.findall(r"-\s+(tools/[-_a-zA-Z0-9.]+\.yaml)", provider_yaml)
        expected_tool_paths = {f"tools/{path.name}" for path in (PLUGIN_ROOT / "tools").glob("*.yaml")}
        self.assertEqual(set(tool_paths), expected_tool_paths)
        for relative_tool_path in tool_paths:
            tool_yaml_path = PLUGIN_ROOT / relative_tool_path
            self.assertTrue(tool_yaml_path.is_file(), relative_tool_path)
            tool_yaml = tool_yaml_path.read_text(encoding="utf-8")
            source_match = re.search(r"source:\s+(tools/[-_a-zA-Z0-9.]+\.py)", tool_yaml)
            self.assertIsNotNone(source_match, relative_tool_path)
            self.assertTrue((PLUGIN_ROOT / source_match.group(1)).is_file(), source_match.group(1))

    def test_manifest_and_tools_reference_existing_icon_asset(self) -> None:
        icon = "icon.svg"
        self.assertTrue((PLUGIN_ROOT / "_assets" / icon).is_file())

        manifest = (PLUGIN_ROOT / "manifest.yaml").read_text(encoding="utf-8")
        provider_yaml = (PLUGIN_ROOT / "provider" / "tdai_memory.yaml").read_text(encoding="utf-8")

        self.assertIn(f"icon: {icon}", manifest)
        self.assertIn(f"icon: {icon}", provider_yaml)
        self.assertNotIn("icon: _assets/", manifest)
        self.assertNotIn("icon: _assets/", provider_yaml)

    def test_quickstart_and_architecture_docs_are_present(self) -> None:
        quickstart = PLUGIN_ROOT / "scripts" / "quickstart-gateway-mock-e2e.sh"
        mock_server = PLUGIN_ROOT / "scripts" / "mock_dify_plugin_server.py"
        architecture = PLUGIN_ROOT / "ARCHITECTURE.md"
        install_guide = REPO_ROOT / "docs" / "dify-plugin-installation-guide.md"
        workflow = REPO_ROOT / "docs" / "dify-workflow-diagram.md"

        for path in [quickstart, mock_server, architecture, install_guide, workflow]:
            self.assertTrue(path.is_file(), str(path))

        quickstart_text = quickstart.read_text(encoding="utf-8")
        self.assertIn("src/gateway/server.ts", quickstart_text)
        self.assertIn("mock_dify_plugin_server.py", quickstart_text)
        self.assertIn("tdai_capture", quickstart_text)
        self.assertIn("tdai_conversation_search", quickstart_text)
        self.assertIn("tdai_recall", quickstart_text)
        self.assertIn("tdai_session_end", quickstart_text)
        self.assertIn("json.dumps", quickstart_text)
        self.assertIn("find_curl", quickstart_text)
        self.assertIn("trap cleanup EXIT INT TERM", quickstart_text)
        self.assertIn("Failed to invoke tdai_capture", quickstart_text)
        self.assertIn("Failed to invoke tdai_session_end", quickstart_text)
        self.assertIn("L0 read-back", quickstart_text)
        self.assertIn("Failed to invoke tdai_recall", quickstart_text)
        self.assertIn("recall call", quickstart_text)
        self.assertNotIn("CAPTURE_BODY=$(cat <<JSON", quickstart_text)
        self.assertNotIn("RECALL_BODY=$(cat <<JSON", quickstart_text)

        workflow_text = workflow.read_text(encoding="utf-8")
        self.assertIn("```mermaid", workflow_text)
        self.assertIn("Dify", workflow_text)
        self.assertIn("Gateway", workflow_text)
        self.assertIn("TdaiCore", workflow_text)

        architecture_text = architecture.read_text(encoding="utf-8")
        for expected in ["plugin", "Gateway", "Core", "capture", "recall"]:
            self.assertIn(expected, architecture_text)

        install_guide_text = install_guide.read_text(encoding="utf-8")
        for expected in [
            "dify plugin package",
            "tdai_capture",
            "tdai_conversation_search",
            "tdai_session_end",
            "PluginToolManager",
            "L0 read path",
            "transport shim",
            "Gateway Client Adapter Kit",
        ]:
            self.assertIn(expected, install_guide_text)
        self.assertIn('"memory_count": 0', install_guide_text)

    def test_dify_plugin_ci_workflow_is_present(self) -> None:
        workflow = REPO_ROOT / ".github" / "workflows" / "dify-plugin-ci.yml"
        self.assertTrue(workflow.is_file(), str(workflow))

        workflow_text = workflow.read_text(encoding="utf-8")
        self.assertIn("python -m unittest discover -s dify-plugin-tdai-memory/tests", workflow_text)
        self.assertIn("test_plugin_manifest.py", workflow_text)
        self.assertIn("setup-python", workflow_text)

    def test_readme_contains_l0_read_path_reference(self) -> None:
        readme = PLUGIN_ROOT / "README.md"
        self.assertTrue(readme.is_file(), str(readme))

        readme_text = readme.read_text(encoding="utf-8")
        self.assertIn("L0 read path", readme_text)
        self.assertIn("transport shim", readme_text)
        self.assertIn("Gateway Client Adapter Kit", readme_text)

    def test_llm_descriptions_are_prompt_budget_friendly(self) -> None:
        for tool_yaml_path in (PLUGIN_ROOT / "tools").glob("*.yaml"):
            text = tool_yaml_path.read_text(encoding="utf-8")
            for description in _inline_yaml_values(text, "llm_description"):
                self.assertLessEqual(
                    len(description.strip()),
                    MAX_LLM_DESCRIPTION_LENGTH,
                    f"{tool_yaml_path.name}: {description}",
                )

    def test_max_chars_zero_semantics_are_documented(self) -> None:
        for tool_yaml_path in (PLUGIN_ROOT / "tools").glob("*.yaml"):
            text = tool_yaml_path.read_text(encoding="utf-8")
            max_chars_block = _parameter_blocks(text).get("max_chars")
            if max_chars_block is not None:
                self.assertIn("0 means unlimited", max_chars_block, tool_yaml_path.name)

    def test_dify_dependency_is_pinned(self) -> None:
        pyproject = (PLUGIN_ROOT / "pyproject.toml").read_text(encoding="utf-8")

        self.assertIn('"dify_plugin~=0.9.0"', pyproject)
        self.assertIn("[build-system]", pyproject)
        self.assertIn('description = "Connect Dify workflows', pyproject)
        self.assertIn('readme = "README.md"', pyproject)
        self.assertIn('license = { text = "MIT" }', pyproject)
