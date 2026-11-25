import re

p = r"C:\Users\liuwentai\AppData\Roaming\Adobe\CEP\extensions\F2A\figma-plugin\code.js"
data = open(p, encoding="utf-8", errors="replace").read()
# tool/command names appear as name:"xxx" in the MCP command registry
names = sorted(set(re.findall(r'name:"([a-z][a-z0-9_]{2,40})"', data)))
candidates = [n for n in names if any(k in n for k in ("effect", "fill", "stroke", "blur", "paint", "node", "layer", "style", "set_", "create_"))]
print(len(candidates), "candidates")
for n in candidates:
    print(n)
