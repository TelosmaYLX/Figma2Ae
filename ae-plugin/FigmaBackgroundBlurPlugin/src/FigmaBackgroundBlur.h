/*******************************************************************/
/*  FigmaBackgroundBlur.h                                          */
/*                                                                 */
/*  "Figma 背景模糊" - After Effects effect plug-in (v1.3)          */
/*  Real-time reproduction of Figma's background-blur renderer:    */
/*    - separable triangular (Bartlett) kernel                     */
/*    - shape-clamped normalized convolution (Figma clamp)         */
/*    - the blur region is driven by a SHAPE LAYER'S ALPHA CHANNEL */
/*      (put the effect on an adjustment layer, pick the shape)    */
/*                                                                 */
/*  Algorithm reverse-engineered from Figma 126.8.16 (see the      */
/*  analysis documents in the project workspace).                  */
/*******************************************************************/

#pragma once

#ifndef FIGMA_BACKGROUND_BLUR_H
#define FIGMA_BACKGROUND_BLUR_H

typedef unsigned char u_char;
typedef unsigned short u_short;
typedef unsigned short u_int16;
typedef unsigned long u_long;
typedef short int int16;

#define PF_TABLE_BITS 12
#define PF_TABLE_SZ_16 4096

#define PF_DEEP_COLOR_AWARE 1 // we handle 16bpc pixels (AE_Effect.h checks for this)

#include "AEConfig.h"

#ifdef AE_OS_WIN
typedef unsigned short PixelType;
#include <Windows.h>
#endif

#include "entry.h"
#include "AE_Effect.h"
#include "AE_EffectCB.h"
#include "AE_Macros.h"
#include "Param_Utils.h"
#include "AE_EffectCBSuites.h"
#include "String_Utils.h"
#include "AE_GeneralPlug.h"
#include "AEFX_ChannelDepthTpl.h"
#include "AEGP_SuiteHandler.h"

#include "FigmaBackgroundBlur_Strings.h"

/* Versioning information */

#define MAJOR_VERSION 1
#define MINOR_VERSION 8
#define BUG_VERSION 0
#define STAGE_VERSION PF_Stage_DEVELOP
#define BUILD_VERSION 1

/* Parameter defaults */

#define FGB_RADIUS_MIN 0.0
#define FGB_RADIUS_MAX 2000.0
#define FGB_RADIUS_DFLT 40.0

enum
{
    FGB_INPUT = 0,
    FGB_MODE,
    FGB_RADIUS,
    FGB_START_RADIUS,
    FGB_END_RADIUS,
    FGB_GRAD_SX, // ramp start X, percent of the blur bounds
    FGB_GRAD_SY, // ramp start Y, percent of the blur bounds
    FGB_GRAD_EX, // ramp end X, percent of the blur bounds
    FGB_GRAD_EY, // ramp end Y, percent of the blur bounds
    FGB_AA_EDGE,
    FGB_MASK_LAYER,
    FGB_NUM_PARAMS
};

enum
{
    FGB_MODE_DISK_ID = 1,
    FGB_RADIUS_DISK_ID,
    FGB_START_RADIUS_DISK_ID,
    FGB_END_RADIUS_DISK_ID,
    FGB_GRAD_SX_DISK_ID,
    FGB_GRAD_SY_DISK_ID,
    FGB_GRAD_EX_DISK_ID,
    FGB_GRAD_EY_DISK_ID,
    FGB_AA_EDGE_DISK_ID,
    FGB_MASK_LAYER_DISK_ID
};

extern "C"
{

    DllExport PF_Err EffectMain(
        PF_Cmd cmd, PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_LayerDef* output, void* extra);
}

#endif // FIGMA_BACKGROUND_BLUR_H
