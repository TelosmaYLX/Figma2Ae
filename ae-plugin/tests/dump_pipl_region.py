import os

aex = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c\ae-plugin\build\FigmaBackgroundBlur.aex"
data = open(aex, "rb").read()
print("size", len(data))

patterns = [
    ("name", b"Figma \xe8\x83\x8c\xe6\x99\xaf\xe6\xa8\xa1\xe7\xb3\x8a"),
    ("category", b"F2A \xe6\x8f\x92\xe4\xbb\xb6"),
]
for label, pat in patterns:
    i = data.find(pat)
    print(label, "at", i)
    if i >= 0:
        start = max(0, i - 10)
        end = min(len(data), i + len(pat) + 12)
        print("  hex:", data[start:end].hex())
        print("  repr:", data[start:end])
