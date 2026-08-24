#!/usr/bin/env python3
"""Preprocess review-schema.json for lm-format-enforcer compatibility.

lm-format-enforcer:
- Uses "definitions" not "$defs" (Draft 4/7 convention)
- Does not support "type": "null" or mixed ["string", "null"]
- Does not support oneOf/anyOf with null alternatives

This script removes null types, unwraps single-element oneOf, and renames $defs.
"""

import json
import sys


def preprocess(schema_node):
    """Recursively remove null types and resolve references."""
    if isinstance(schema_node, dict):
        # Remove type: "null" entirely
        if "type" in schema_node:
            if schema_node["type"] == "null":
                schema_node = {k: v for k, v in schema_node.items() if k != "type"}
            elif isinstance(schema_node["type"], list):
                non_null = [t for t in schema_node["type"] if t != "null"]
                if len(non_null) == 1:
                    schema_node = {**schema_node, "type": non_null[0]}
                elif len(non_null) == 0:
                    schema_node = {k: v for k, v in schema_node.items() if k != "type"}

        # Remove null alternatives from oneOf/anyOf
        for key in ("oneOf", "anyOf", "allOf"):
            if key in schema_node:
                filtered = [
                    item
                    for item in schema_node[key]
                    if not (isinstance(item, dict) and item.get("type") == "null")
                ]
                if len(filtered) == 1:
                    merged = {**schema_node, **filtered[0]}
                    del merged[key]
                    schema_node = merged
                elif len(filtered) > 0:
                    schema_node = {**schema_node, key: filtered}
                else:
                    schema_node = {
                        k: v for k, v in schema_node.items() if k != key
                    }

        # Resolve $ref from $defs -> definitions
        if "$ref" in schema_node:
            ref = schema_node["$ref"]
            if ref.startswith("#/$defs/"):
                schema_node["$ref"] = "#/definitions/" + ref[len("#/$defs/"):]

        # Recurse
        return {k: preprocess(v) for k, v in schema_node.items()}

    elif isinstance(schema_node, list):
        return [preprocess(v) for v in schema_node]

    return schema_node


def main():
    if len(sys.argv) < 2:
        print("Usage: preprocess_schema.py <input-schema> [output-schema]")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else None

    with open(input_path, "r", encoding="utf-8") as f:
        schema = json.load(f)

    # Remove keys that confuse lm-format-enforcer
    for key in ("$schema", "$id",):
        schema.pop(key, None)

    # Remove allOf with if/then/else — lm-format-enforcer can't handle it
    # The conditional rules (e.g., peer_review fields) are not needed for general review
    schema.pop("allOf", None)

    # Rename $defs to definitions for lm-format-enforcer
    if "$defs" in schema:
        schema["definitions"] = schema.pop("$defs")

    # Preprocess everything
    processed = preprocess(schema)

    if output_path:
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(processed, f, ensure_ascii=False, indent=2)
        print(f"Written: {output_path} ({len(json.dumps(processed))} chars)")
    else:
        print(json.dumps(processed, ensure_ascii=False, indent=2))

    # Validate
    try:
        from lmformatenforcer import JsonSchemaParser
        JsonSchemaParser(processed)
        print("Schema validation: OK")
    except ImportError:
        print("lm-format-enforcer not available, skipping validation")
    except Exception as e:
        print(f"Schema validation FAILED: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
