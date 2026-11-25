/*******************************************************************/
/*  FigmaImageGrade.h                                              */
/*                                                                 */
/*  "Figma 调色" - After Effects effect plug-in (v1.0)              */
/*                                                                 */
/*  Exact reproduction of Figma's image-fill colour grade, i.e. the */
/*  seven ImagePaint.filters controls:                              */
/*    曝光 exposure, 对比度 contrast, 饱和度 saturation,            */
/*    白平衡 temperature, 着色 tint, 高光 highlights, 阴影 shadows. */
/*                                                                 */
/*  The shader was reverse-engineered from Figma 126.8.16 (see      */
/*  tests/image-filter-study.md) and validated against its PNG      */
/*  export: the floating point model reproduces 99.9967% of all     */
/*  8-bit RGB channel values exactly and never differs by more than */
/*  one code value.                                                 */
/*                                                                 */
/*  Slider values are the Figma UI values (-100..100); the shader   */
/*  works in -1..1 (value / 100), which is exactly what the Figma   */
/*  plugin API reports as ImagePaint.filters.                       */
/*******************************************************************/

#pragma once

#ifndef FIGMA_IMAGE_GRADE_H
#define FIGMA_IMAGE_GRADE_H

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

#include "FigmaImageGrade_Strings.h"

/* Versioning information */

#define MAJOR_VERSION 1
#define MINOR_VERSION 3
#define BUG_VERSION 0
#define STAGE_VERSION PF_Stage_DEVELOP
#define BUILD_VERSION 1

/* Parameter defaults - Figma UI units (the plug-in API value is this / 100) */

#define GRADE_VALUE_MIN (-100.0)
#define GRADE_VALUE_MAX (100.0)
#define GRADE_VALUE_DFLT (0.0)

enum
{
    GRADE_INPUT = 0,
    GRADE_EXPOSURE,
    GRADE_CONTRAST,
    GRADE_SATURATION,
    GRADE_TEMPERATURE,
    GRADE_TINT,
    GRADE_HIGHLIGHTS,
    GRADE_SHADOWS,
    GRADE_NUM_PARAMS
};

enum
{
    GRADE_EXPOSURE_DISK_ID = 1,
    GRADE_CONTRAST_DISK_ID,
    GRADE_SATURATION_DISK_ID,
    GRADE_TEMPERATURE_DISK_ID,
    GRADE_TINT_DISK_ID,
    GRADE_HIGHLIGHTS_DISK_ID,
    GRADE_SHADOWS_DISK_ID
};

extern "C"
{

    DllExport PF_Err EffectMain(
        PF_Cmd cmd, PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_LayerDef* output, void* extra);
}

#endif // FIGMA_IMAGE_GRADE_H
