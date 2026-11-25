aex = r"D:\Tools\F2A\.agents\worktrees\dsh-f012f7f8-067c\ae-plugin\build\FigmaBackgroundBlur.aex"
data = open(aex, "rb").read()

for pat in [b"eman", b"gtac", b"MIB8", b"8BIM", b"lur", b"F2A \xe6\x8f\x92\xe4\xbb\xb6", b"Figma \xe8"]:
    starts = []
    i = 0
    while True:
        j = data.find(pat, i)
        if j < 0:
            break
        starts.append(j)
        i = j + 1
    print(pat, "->", starts[:6])

# dump around 'eman'
i = data.find(b"eman")
if i >= 0:
    s = max(0, i - 12)
    print("\neman region hex:", data[s:i + 60].hex())
    print("eman region repr:", data[s:i + 60])
