#!/usr/bin/env python3
"""Generate simple PNG icons for the extension."""
import struct, zlib, os

def make_png(size, r, g, b):
    def chunk(t, d):
        c = zlib.crc32(t + d) & 0xffffffff
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', c)

    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    raw = b''.join(b'\x00' + bytes([r, g, b] * size) for _ in range(size))
    idat = chunk(b'IDAT', zlib.compress(raw))
    iend = chunk(b'IEND', b'')
    return b'\x89PNG\r\n\x1a\n' + ihdr + idat + iend

# Brighter blue for visibility
R, G, B = 30, 64, 175  # #1e40af

os.makedirs('icons', exist_ok=True)
for size in [16, 48, 128]:
    path = f'icons/icon{size}.png'
    with open(path, 'wb') as f:
        f.write(make_png(size, R, G, B))
    print(f'Created {path}')

print('Icons generated.')
