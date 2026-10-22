import zstandard as zstd
import os

print("=== ЧАС 1: Парсинг бинарной демки CS2 ===")
dem_path = "1-45e25330-31f6-44ab-9483-9f1ffaf15c6a-1-1.dem.zst"
output_dem = "match_uncompressed.dem"

if os.path.exists(dem_path):
    print(f"Распаковываем {dem_path}...")
    dctx = zstd.ZstdDecompressor()
    with open(dem_path, "rb") as f_in, open(output_dem, "wb") as f_out:
        dctx.copy_stream(f_in, f_out)
    print(f"Успешно распаковано! Размер файла: {os.path.getsize(output_dem)} байт")
    
    # Quick scan for player positions/ticks markers
    with open(output_dem, "rb") as f:
        header = f.read(256)
        print("Заголовок демки (magic):", header[:12])
else:
    print("Файл демки не найден в текущей директории.")
