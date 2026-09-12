import unittest

from pydantic import BaseModel

from memory_tencentdb_pydantic_ai.serialization import serialize_output


class Profile(BaseModel):
    language: str
    score: int


class SerializeOutputTests(unittest.TestCase):
    def test_string_is_not_json_quoted(self) -> None:
        self.assertEqual(serialize_output("你好"), "你好")

    def test_pydantic_model_is_stable_json(self) -> None:
        output = serialize_output(Profile(language="zh", score=9))

        self.assertEqual(output, '{"language":"zh","score":9}')

    def test_mapping_keys_are_sorted(self) -> None:
        self.assertEqual(
            serialize_output({"z": 1, "a": "中"}),
            '{"a":"中","z":1}',
        )


if __name__ == "__main__":
    unittest.main()
