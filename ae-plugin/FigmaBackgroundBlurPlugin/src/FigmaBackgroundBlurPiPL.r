#include "AEConfig.h"
#include "AE_EffectVers.h"

#ifndef AE_OS_WIN
	#include <AE_General.r>
#endif

/*
    NOTE: the PiPL Name / Category below are fixed-length ASCII placeholders.
    After the build, tools/patch_pipl_name.py rewrites those two Pascal strings
    with the Chinese names in the system ANSI code page (CP936) that After
    Effects uses to decode PiPL names on a Chinese Windows installation.
    Placeholder lengths are chosen so the patched strings have exactly the same
    byte length (16 / 12 bytes including the Pascal length prefix and padding),
    which keeps the PiPL layout (and all internal offsets) unchanged.
*/

resource 'PiPL' (16000) {
	{	/* array properties: 12 elements */
		/* [1] */
		Kind {
			AEEffect
		},
		/* [2] */
		Name {
			"FigmaBgBlurPadd"
		},
		/* [3] */
		Category {
			"F2A PlugZz"
		},
#ifdef AE_OS_WIN
    #if defined(AE_PROC_INTELx64)
		CodeWin64X86 {"EffectMain"},
    #elif defined(AE_PROC_ARM64)
		CodeWinARM64 {"EffectMain"},
    #endif
#elif defined(AE_OS_MAC)
		CodeMacIntel64 {"EffectMain"},
		CodeMacARM64 {"EffectMain"},
#endif
		/* [6] */
		AE_PiPL_Version {
			2,
			0
		},
		/* [7] */
		AE_Effect_Spec_Version {
			PF_PLUG_IN_VERSION,
			PF_PLUG_IN_SUBVERS
		},
		/* [8] */
		AE_Effect_Version {
			788481 /* 1.8.1 */
		},
		/* [9] */
		AE_Effect_Info_Flags {
			0
		},
		/* [10] */
		AE_Effect_Global_OutFlags {
			0x06000000 /* deep color and parameter UI updates, matching GlobalSetup */
		},
		AE_Effect_Global_OutFlags_2 {
			0x48000000 /* threaded rendering and UTF-8 strings, matching GlobalSetup */
		},
		/* [11] */
		AE_Effect_Match_Name {
			"F2A Figma Background Blur"
		},
		/* [12] */
		AE_Reserved_Info {
			0
		},
		/* [13] */
		AE_Effect_Support_URL {
			"https://www.figma.com"
		}
	}
};




