// Direct Figwright Figma API handlers; F2A owns transport, queue, batches and undo.
import {createAddComponentPropertyHandler} from '../vendor/figwright/packages/plugin/src/handlers/add-component-property.js';
import {createAddPageHandler} from '../vendor/figwright/packages/plugin/src/handlers/add-page.js';
import {createAddVariableModeHandler} from '../vendor/figwright/packages/plugin/src/handlers/add-variable-mode.js';
import {createAlignNodesHandler} from '../vendor/figwright/packages/plugin/src/handlers/align-nodes.js';
import {createApplyAnimationStyleHandler} from '../vendor/figwright/packages/plugin/src/handlers/apply-animation-style.js';
import {createApplyManualKeyframeTrackHandler} from '../vendor/figwright/packages/plugin/src/handlers/apply-manual-keyframe-track.js';
import {createApplyStyleToNodeHandler} from '../vendor/figwright/packages/plugin/src/handlers/apply-style-to-node.js';
import {createBindComponentPropertyHandler} from '../vendor/figwright/packages/plugin/src/handlers/bind-component-property.js';
import {createBindVariableToNodeHandler} from '../vendor/figwright/packages/plugin/src/handlers/bind-variable-to-node.js';
import {createBindVariableToPaintHandler} from '../vendor/figwright/packages/plugin/src/handlers/bind-variable-to-paint.js';
import {createBooleanNodesHandler} from '../vendor/figwright/packages/plugin/src/handlers/boolean-nodes.js';
import {createCombineAsVariantsHandler} from '../vendor/figwright/packages/plugin/src/handlers/combine-as-variants.js';
import {createCreateComponentHandler} from '../vendor/figwright/packages/plugin/src/handlers/create-component.js';
import {createCreateEffectStyleHandler} from '../vendor/figwright/packages/plugin/src/handlers/create-effect-style.js';
import {createCreateEllipseHandler} from '../vendor/figwright/packages/plugin/src/handlers/create-ellipse.js';
import {createCreateGridStyleHandler} from '../vendor/figwright/packages/plugin/src/handlers/create-grid-style.js';
import {createCreateInstanceHandler} from '../vendor/figwright/packages/plugin/src/handlers/create-instance.js';
import {createCreatePaintStyleHandler} from '../vendor/figwright/packages/plugin/src/handlers/create-paint-style.js';
import {createCreateShapeHandler} from '../vendor/figwright/packages/plugin/src/handlers/create-shape.js';
import {createCreateTextPathHandler} from '../vendor/figwright/packages/plugin/src/handlers/text-path.js';
import {createCreateTextStyleHandler} from '../vendor/figwright/packages/plugin/src/handlers/create-text-style.js';
import {createCreateVariableCollectionHandler} from '../vendor/figwright/packages/plugin/src/handlers/create-variable-collection.js';
import {createCreateVariableHandler} from '../vendor/figwright/packages/plugin/src/handlers/create-variable.js';
import {createCreateVectorHandler} from '../vendor/figwright/packages/plugin/src/handlers/vector.js';
import {createDeleteComponentPropertyHandler} from '../vendor/figwright/packages/plugin/src/handlers/delete-component-property.js';
import {createDeleteNodesHandler} from '../vendor/figwright/packages/plugin/src/handlers/delete-nodes.js';
import {createDeletePageHandler} from '../vendor/figwright/packages/plugin/src/handlers/delete-page.js';
import {createDeleteStyleHandler} from '../vendor/figwright/packages/plugin/src/handlers/delete-style.js';
import {createDeleteVariableCollectionHandler} from '../vendor/figwright/packages/plugin/src/handlers/delete-variable-collection.js';
import {createDeleteVariableModeHandler} from '../vendor/figwright/packages/plugin/src/handlers/delete-variable-mode.js';
import {createDeleteVariableHandler} from '../vendor/figwright/packages/plugin/src/handlers/delete-variable.js';
import {createDetachInstanceHandler} from '../vendor/figwright/packages/plugin/src/handlers/detach-instance.js';
import {createEditComponentPropertyHandler} from '../vendor/figwright/packages/plugin/src/handlers/edit-component-property.js';
import {createExportPdfHandler} from '../vendor/figwright/packages/plugin/src/handlers/export-pdf.js';
import {createExportVideoHandler} from '../vendor/figwright/packages/plugin/src/handlers/export-video.js';
import {createFindReplaceTextHandler} from '../vendor/figwright/packages/plugin/src/handlers/find-replace-text.js';
import {createFlattenNodesHandler} from '../vendor/figwright/packages/plugin/src/handlers/flatten-nodes.js';
import {createFlipNodesHandler} from '../vendor/figwright/packages/plugin/src/handlers/flip-nodes.js';
import {createGetAnnotationsHandler} from '../vendor/figwright/packages/plugin/src/handlers/get-annotations.js';
import {createGetComponentApiHandler} from '../vendor/figwright/packages/plugin/src/handlers/get-component-api.js';
import {createGetDesignContextHandler} from '../vendor/figwright/packages/plugin/src/handlers/get-design-context.js';
import {createGetDocumentHandler} from '../vendor/figwright/packages/plugin/src/handlers/get-document.js';
import {createGetFontsHandler} from '../vendor/figwright/packages/plugin/src/handlers/get-fonts.js';
import {createGetLocalComponentsHandler} from '../vendor/figwright/packages/plugin/src/handlers/get-local-components.js';
import {createGetMetadataHandler} from '../vendor/figwright/packages/plugin/src/handlers/get-metadata.js';
import {createGetMotionContextHandler} from '../vendor/figwright/packages/plugin/src/handlers/get-motion-context.js';
import {createGetMotionStylesHandler} from '../vendor/figwright/packages/plugin/src/handlers/get-motion-styles.js';
import {createGetNodeMotionHandler} from '../vendor/figwright/packages/plugin/src/handlers/get-node-motion.js';
import {createGetNodeHandler} from '../vendor/figwright/packages/plugin/src/handlers/get-node.js';
import {createGetNodesInfoHandler} from '../vendor/figwright/packages/plugin/src/handlers/get-nodes-info.js';
import {createGetPagesHandler} from '../vendor/figwright/packages/plugin/src/handlers/get-pages.js';
import {createGetReactionsHandler} from '../vendor/figwright/packages/plugin/src/handlers/get-reactions.js';
import {createGetScreenshotHandler} from '../vendor/figwright/packages/plugin/src/handlers/get-screenshot.js';
import {createGetStylesHandler} from '../vendor/figwright/packages/plugin/src/handlers/get-styles.js';
import {createGetVariableDefsHandler} from '../vendor/figwright/packages/plugin/src/handlers/get-variable-defs.js';
import {createGetVectorHandler} from '../vendor/figwright/packages/plugin/src/handlers/vector.js';
import {createGetViewportHandler} from '../vendor/figwright/packages/plugin/src/handlers/get-viewport.js';
import {createImportImageHandler} from '../vendor/figwright/packages/plugin/src/handlers/import-image.js';
import {createImportStyleHandler} from '../vendor/figwright/packages/plugin/src/handlers/import-style.js';
import {createImportSvgHandler} from '../vendor/figwright/packages/plugin/src/handlers/import-svg.js';
import {createImportVariableHandler} from '../vendor/figwright/packages/plugin/src/handlers/import-variable.js';
import {createSetLockedHandler} from '../vendor/figwright/packages/plugin/src/handlers/lock-nodes.js';
import {createMoveNodesHandler} from '../vendor/figwright/packages/plugin/src/handlers/move-nodes.js';
import {createNavigateToPageHandler} from '../vendor/figwright/packages/plugin/src/handlers/navigate-to-page.js';
import {createOutlineStrokeHandler} from '../vendor/figwright/packages/plugin/src/handlers/vector.js';
import {createPingHandler} from '../vendor/figwright/packages/plugin/src/handlers/ping.js';
import {createRemoveAnimationStyleHandler} from '../vendor/figwright/packages/plugin/src/handlers/remove-animation-style.js';
import {createRemoveManualKeyframeTrackHandler} from '../vendor/figwright/packages/plugin/src/handlers/remove-manual-keyframe-track.js';
import {createRemoveReactionsHandler} from '../vendor/figwright/packages/plugin/src/handlers/remove-reactions.js';
import {createRenamePageHandler} from '../vendor/figwright/packages/plugin/src/handlers/rename-page.js';
import {createRenameVariableHandler} from '../vendor/figwright/packages/plugin/src/handlers/rename-variable.js';
import {createRepeatNodesHandler} from '../vendor/figwright/packages/plugin/src/handlers/repeat.js';
import {createResizeNodesHandler} from '../vendor/figwright/packages/plugin/src/handlers/resize-nodes.js';
import {createRotateNodesHandler} from '../vendor/figwright/packages/plugin/src/handlers/rotate-nodes.js';
import {createSaveImageFillsHandler} from '../vendor/figwright/packages/plugin/src/handlers/save-image-fills.js';
import {createSetArcHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-arc.js';
import {createSetAutoLayoutHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-auto-layout.js';
import {createSetBlendModeHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-blend-mode.js';
import {createSetComplexStrokeHandler} from '../vendor/figwright/packages/plugin/src/handlers/complex-stroke.js';
import {createSetConstraintsHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-constraints.js';
import {createSetEffectsHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-effects.js';
import {createSetFillsHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-fills.js';
import {createSetImageFillHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-image-fill.js';
import {createSetInstancePropertiesHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-instance-properties.js';
import {createSetLayoutGridsHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-layout-grids.js';
import {createSetLayoutPropsHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-layout-props.js';
import {createSetMaskHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-mask.js';
import {createSetNodeVariableModeHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-node-variable-mode.js';
import {createSetOpacityHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-opacity.js';
import {createSetPositionHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-position.js';
import {createSetReactionsHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-reactions.js';
import {createSetRepeatHandler} from '../vendor/figwright/packages/plugin/src/handlers/repeat.js';
import {createSetStrokesHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-strokes.js';
import {createSetTextPathHandler} from '../vendor/figwright/packages/plugin/src/handlers/text-path.js';
import {createSetTextPropertiesHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-text-properties.js';
import {createSetTextRangeHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-text-range.js';
import {createSetTextHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-text.js';
import {createSetTimelineDurationHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-timeline-duration.js';
import {createSetVariableCodeSyntaxHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-variable-code-syntax.js';
import {createSetVariableValueHandler} from '../vendor/figwright/packages/plugin/src/handlers/set-variable-value.js';
import {createSetVectorHandler} from '../vendor/figwright/packages/plugin/src/handlers/vector.js';
import {createSwapComponentHandler} from '../vendor/figwright/packages/plugin/src/handlers/swap-component.js';
import {createUpdateEffectStyleHandler} from '../vendor/figwright/packages/plugin/src/handlers/update-effect-style.js';
import {createUpdateFlowsHandler} from '../vendor/figwright/packages/plugin/src/handlers/update-flows.js';
import {createUpdatePaintStyleHandler} from '../vendor/figwright/packages/plugin/src/handlers/update-paint-style.js';
import {createUpdateTextStyleHandler} from '../vendor/figwright/packages/plugin/src/handlers/update-text-style.js';
import {createUpdateVariableCollectionHandler} from '../vendor/figwright/packages/plugin/src/handlers/update-variable-collection.js';
import {withInstanceIdLookup} from '../vendor/figwright/packages/plugin/src/node-lookup.js';
export {resumeHostYield} from '../vendor/figwright/packages/plugin/src/cooperative.js';
export function createFigwrightCommands(figmaApi: typeof figma) {
  const figmaCtx = withInstanceIdLookup(figmaApi);
  return {
    add_component_property: createAddComponentPropertyHandler(figmaCtx),
    add_page: createAddPageHandler(figmaCtx),
    add_variable_mode: createAddVariableModeHandler(figmaCtx),
    align_nodes: createAlignNodesHandler(figmaCtx),
    apply_animation_style: createApplyAnimationStyleHandler(figmaCtx),
    apply_manual_keyframe_track: createApplyManualKeyframeTrackHandler(figmaCtx),
    apply_style_to_node: createApplyStyleToNodeHandler(figmaCtx),
    bind_component_property: createBindComponentPropertyHandler(figmaCtx),
    bind_variable_to_node: createBindVariableToNodeHandler(figmaCtx),
    bind_variable_to_paint: createBindVariableToPaintHandler(figmaCtx),
    boolean_nodes: createBooleanNodesHandler(figmaCtx),
    combine_as_variants: createCombineAsVariantsHandler(figmaCtx),
    create_component: createCreateComponentHandler(figmaCtx),
    create_effect_style: createCreateEffectStyleHandler(figmaCtx),
    create_ellipse: createCreateEllipseHandler(figmaCtx),
    create_grid_style: createCreateGridStyleHandler(figmaCtx),
    create_instance: createCreateInstanceHandler(figmaCtx),
    create_paint_style: createCreatePaintStyleHandler(figmaCtx),
    create_shape: createCreateShapeHandler(figmaCtx),
    create_text_path: createCreateTextPathHandler(figmaCtx),
    create_text_style: createCreateTextStyleHandler(figmaCtx),
    create_variable_collection: createCreateVariableCollectionHandler(figmaCtx),
    create_variable: createCreateVariableHandler(figmaCtx),
    create_vector: createCreateVectorHandler(figmaCtx),
    delete_component_property: createDeleteComponentPropertyHandler(figmaCtx),
    delete_nodes: createDeleteNodesHandler(figmaCtx),
    delete_page: createDeletePageHandler(figmaCtx),
    delete_style: createDeleteStyleHandler(figmaCtx),
    delete_variable_collection: createDeleteVariableCollectionHandler(figmaCtx),
    delete_variable_mode: createDeleteVariableModeHandler(figmaCtx),
    delete_variable: createDeleteVariableHandler(figmaCtx),
    detach_instance: createDetachInstanceHandler(figmaCtx),
    edit_component_property: createEditComponentPropertyHandler(figmaCtx),
    export_pdf: createExportPdfHandler(figmaCtx),
    export_video: createExportVideoHandler(figmaCtx),
    find_replace_text: createFindReplaceTextHandler(figmaCtx),
    flatten_nodes: createFlattenNodesHandler(figmaCtx),
    flip_nodes: createFlipNodesHandler(figmaCtx),
    get_design_annotations: createGetAnnotationsHandler(figmaCtx),
    get_component_api: createGetComponentApiHandler(figmaCtx),
    get_design_context: createGetDesignContextHandler(figmaCtx),
    get_document: createGetDocumentHandler(figmaCtx),
    get_fonts: createGetFontsHandler(figmaCtx),
    get_design_components: createGetLocalComponentsHandler(figmaCtx),
    get_metadata: createGetMetadataHandler(figmaCtx),
    get_motion_context: createGetMotionContextHandler(figmaCtx),
    get_motion_styles: createGetMotionStylesHandler(figmaCtx),
    get_node_motion: createGetNodeMotionHandler(figmaCtx),
    get_node: createGetNodeHandler(figmaCtx),
    get_design_nodes: createGetNodesInfoHandler(figmaCtx),
    get_pages: createGetPagesHandler(figmaCtx),
    get_prototype_reactions: createGetReactionsHandler(figmaCtx),
    get_screenshot: createGetScreenshotHandler(figmaCtx),
    get_design_styles: createGetStylesHandler(figmaCtx),
    get_variable_defs: createGetVariableDefsHandler(figmaCtx),
    get_vector: createGetVectorHandler(figmaCtx),
    get_viewport: createGetViewportHandler(figmaCtx),
    import_image: createImportImageHandler(figmaCtx),
    import_style: createImportStyleHandler(figmaCtx),
    import_svg: createImportSvgHandler(figmaCtx),
    import_variable: createImportVariableHandler(figmaCtx),
    lock_nodes: createSetLockedHandler(figmaCtx, true),
    move_nodes: createMoveNodesHandler(figmaCtx),
    navigate_to_page: createNavigateToPageHandler(figmaCtx),
    outline_stroke: createOutlineStrokeHandler(figmaCtx),
    ping: createPingHandler(figmaCtx),
    remove_animation_style: createRemoveAnimationStyleHandler(figmaCtx),
    remove_manual_keyframe_track: createRemoveManualKeyframeTrackHandler(figmaCtx),
    remove_reactions: createRemoveReactionsHandler(figmaCtx),
    rename_page: createRenamePageHandler(figmaCtx),
    rename_variable: createRenameVariableHandler(figmaCtx),
    repeat_nodes: createRepeatNodesHandler(figmaCtx),
    resize_nodes: createResizeNodesHandler(figmaCtx),
    rotate_nodes: createRotateNodesHandler(figmaCtx),
    save_image_fills: createSaveImageFillsHandler(figmaCtx),
    set_arc: createSetArcHandler(figmaCtx),
    set_auto_layout: createSetAutoLayoutHandler(figmaCtx),
    set_blend_mode: createSetBlendModeHandler(figmaCtx),
    set_complex_stroke: createSetComplexStrokeHandler(figmaCtx),
    set_constraints: createSetConstraintsHandler(figmaCtx),
    set_effects: createSetEffectsHandler(figmaCtx),
    set_fills: createSetFillsHandler(figmaCtx),
    set_design_image_fill: createSetImageFillHandler(figmaCtx),
    set_instance_properties: createSetInstancePropertiesHandler(figmaCtx),
    set_layout_grids: createSetLayoutGridsHandler(figmaCtx),
    set_layout_props: createSetLayoutPropsHandler(figmaCtx),
    set_mask: createSetMaskHandler(figmaCtx),
    set_node_variable_mode: createSetNodeVariableModeHandler(figmaCtx),
    set_opacity: createSetOpacityHandler(figmaCtx),
    set_position: createSetPositionHandler(figmaCtx),
    set_reactions: createSetReactionsHandler(figmaCtx),
    set_repeat: createSetRepeatHandler(figmaCtx),
    set_strokes: createSetStrokesHandler(figmaCtx),
    set_text_path: createSetTextPathHandler(figmaCtx),
    set_text_properties: createSetTextPropertiesHandler(figmaCtx),
    set_text_range: createSetTextRangeHandler(figmaCtx),
    set_text: createSetTextHandler(figmaCtx),
    set_timeline_duration: createSetTimelineDurationHandler(figmaCtx),
    set_variable_code_syntax: createSetVariableCodeSyntaxHandler(figmaCtx),
    set_variable_value: createSetVariableValueHandler(figmaCtx),
    set_vector: createSetVectorHandler(figmaCtx),
    swap_component: createSwapComponentHandler(figmaCtx),
    unlock_nodes: createSetLockedHandler(figmaCtx, false),
    update_effect_style: createUpdateEffectStyleHandler(figmaCtx),
    update_flows: createUpdateFlowsHandler(figmaCtx),
    update_paint_style: createUpdatePaintStyleHandler(figmaCtx),
    update_text_style: createUpdateTextStyleHandler(figmaCtx),
    update_variable_collection: createUpdateVariableCollectionHandler(figmaCtx),
  };
}
export const figwrightWrites = new Set(["add_component_property","add_page","add_variable_mode","align_nodes","apply_animation_style","apply_manual_keyframe_track","apply_style_to_node","bind_component_property","bind_variable_to_node","bind_variable_to_paint","boolean_nodes","combine_as_variants","create_component","create_effect_style","create_ellipse","create_grid_style","create_instance","create_paint_style","create_shape","create_text_path","create_text_style","create_variable_collection","create_variable","create_vector","delete_component_property","delete_nodes","delete_page","delete_style","delete_variable_collection","delete_variable_mode","delete_variable","detach_instance","edit_component_property","find_replace_text","flatten_nodes","flip_nodes","import_image","import_style","import_svg","import_variable","lock_nodes","move_nodes","navigate_to_page","outline_stroke","remove_animation_style","remove_manual_keyframe_track","remove_reactions","rename_page","rename_variable","repeat_nodes","resize_nodes","rotate_nodes","set_arc","set_auto_layout","set_blend_mode","set_complex_stroke","set_constraints","set_effects","set_fills","set_design_image_fill","set_instance_properties","set_layout_grids","set_layout_props","set_mask","set_node_variable_mode","set_opacity","set_position","set_reactions","set_repeat","set_strokes","set_text_path","set_text_properties","set_text_range","set_text","set_timeline_duration","set_variable_code_syntax","set_variable_value","set_vector","swap_component","unlock_nodes","update_effect_style","update_flows","update_paint_style","update_text_style","update_variable_collection"]);
