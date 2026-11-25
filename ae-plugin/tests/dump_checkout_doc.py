import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

path = "sdk/AfterEffectsSDK_27.0_win/Examples/Headers/AE_Effect.h"
text = open(path, "rb").read().decode("utf-8", "replace")

idx = text.find("PF_Err (*checkout_param)(")
print("struct at", idx)
print(text[max(0, idx - 9000) : idx + 400])
