"""Resolve paths after extracting the complete match package."""
import json
from pathlib import Path

def prepare(root):
    root = Path(root).resolve()
    output = root / "OBS_LOCAL"
    output.mkdir(exist_ok=True)
    files = []
    for template in sorted((root / "OFFLINE_TEMPLATES").glob("*.json")):
        document = json.loads(template.read_text(encoding="utf-8"))
        cards = [s for s in document["sources"] if s["name"].startswith("CARD ")]
        if len(cards) != 10:
            raise ValueError("Expected ten cards: " + template.name)
        for source in cards:
            image = (root / source["settings"]["file"]).resolve()
            if not image.is_relative_to(root) or not image.is_file():
                raise FileNotFoundError(str(image))
            source["settings"]["file"] = str(image)
        target = output / template.name
        target.write_text(json.dumps(document,ensure_ascii=False,indent=2) + "\n", encoding="utf-8")
        files.append(target)
    if not files:
        raise FileNotFoundError("No offline templates found.")
    return files

if __name__ == "__main__":
    files = prepare(Path(__file__).resolve().parent)
    print("Ready: " + str(len(files)) + " OBS collections in OBS_LOCAL")
