// Figwright tool specs, pinned by vendor/figwright/UPSTREAM.json. Existing F2A names keep their API.
import {addComponentPropertyTool} from '../vendor/figwright/packages/mcp/src/tools/add-component-property.js';
import {addPageTool} from '../vendor/figwright/packages/mcp/src/tools/add-page.js';
import {addVariableModeTool} from '../vendor/figwright/packages/mcp/src/tools/add-variable-mode.js';
import {alignNodesTool} from '../vendor/figwright/packages/mcp/src/tools/align-nodes.js';
import {applyAnimationStyleTool} from '../vendor/figwright/packages/mcp/src/tools/apply-animation-style.js';
import {applyManualKeyframeTrackTool} from '../vendor/figwright/packages/mcp/src/tools/apply-manual-keyframe-track.js';
import {applyStyleToNodeTool} from '../vendor/figwright/packages/mcp/src/tools/apply-style-to-node.js';
import {bindComponentPropertyTool} from '../vendor/figwright/packages/mcp/src/tools/bind-component-property.js';
import {bindVariableToNodeTool} from '../vendor/figwright/packages/mcp/src/tools/bind-variable-to-node.js';
import {bindVariableToPaintTool} from '../vendor/figwright/packages/mcp/src/tools/bind-variable-to-paint.js';
import {booleanNodesTool} from '../vendor/figwright/packages/mcp/src/tools/boolean-nodes.js';
import {combineAsVariantsTool} from '../vendor/figwright/packages/mcp/src/tools/combine-as-variants.js';
import {createComponentTool} from '../vendor/figwright/packages/mcp/src/tools/create-component.js';
import {createEffectStyleTool} from '../vendor/figwright/packages/mcp/src/tools/create-effect-style.js';
import {createEllipseTool} from '../vendor/figwright/packages/mcp/src/tools/create-ellipse.js';
import {createGridStyleTool} from '../vendor/figwright/packages/mcp/src/tools/create-grid-style.js';
import {createInstanceTool} from '../vendor/figwright/packages/mcp/src/tools/create-instance.js';
import {createPaintStyleTool} from '../vendor/figwright/packages/mcp/src/tools/create-paint-style.js';
import {createShapeTool} from '../vendor/figwright/packages/mcp/src/tools/create-shape.js';
import {createTextPathTool} from '../vendor/figwright/packages/mcp/src/tools/create-text-path.js';
import {createTextStyleTool} from '../vendor/figwright/packages/mcp/src/tools/create-text-style.js';
import {createVariableCollectionTool} from '../vendor/figwright/packages/mcp/src/tools/create-variable-collection.js';
import {createVariableTool} from '../vendor/figwright/packages/mcp/src/tools/create-variable.js';
import {createVectorTool} from '../vendor/figwright/packages/mcp/src/tools/create-vector.js';
import {deleteComponentPropertyTool} from '../vendor/figwright/packages/mcp/src/tools/delete-component-property.js';
import {deleteNodesTool} from '../vendor/figwright/packages/mcp/src/tools/delete-nodes.js';
import {deletePageTool} from '../vendor/figwright/packages/mcp/src/tools/delete-page.js';
import {deleteStyleTool} from '../vendor/figwright/packages/mcp/src/tools/delete-style.js';
import {deleteVariableCollectionTool} from '../vendor/figwright/packages/mcp/src/tools/delete-variable-collection.js';
import {deleteVariableModeTool} from '../vendor/figwright/packages/mcp/src/tools/delete-variable-mode.js';
import {deleteVariableTool} from '../vendor/figwright/packages/mcp/src/tools/delete-variable.js';
import {detachInstanceTool} from '../vendor/figwright/packages/mcp/src/tools/detach-instance.js';
import {editComponentPropertyTool} from '../vendor/figwright/packages/mcp/src/tools/edit-component-property.js';
import {exportPdfTool} from '../vendor/figwright/packages/mcp/src/tools/export-pdf.js';
import {exportVideoTool} from '../vendor/figwright/packages/mcp/src/tools/export-video.js';
import {findReplaceTextTool} from '../vendor/figwright/packages/mcp/src/tools/find-replace-text.js';
import {flattenNodesTool} from '../vendor/figwright/packages/mcp/src/tools/flatten-nodes.js';
import {flipNodesTool} from '../vendor/figwright/packages/mcp/src/tools/flip-nodes.js';
import {getAnnotationsTool} from '../vendor/figwright/packages/mcp/src/tools/get-annotations.js';
import {getComponentApiTool} from '../vendor/figwright/packages/mcp/src/tools/get-component-api.js';
import {getDesignContextTool} from '../vendor/figwright/packages/mcp/src/tools/get-design-context.js';
import {getDocumentTool} from '../vendor/figwright/packages/mcp/src/tools/get-document.js';
import {getFontsTool} from '../vendor/figwright/packages/mcp/src/tools/get-fonts.js';
import {getLocalComponentsTool} from '../vendor/figwright/packages/mcp/src/tools/get-local-components.js';
import {getMetadataTool} from '../vendor/figwright/packages/mcp/src/tools/get-metadata.js';
import {getMotionContextTool} from '../vendor/figwright/packages/mcp/src/tools/get-motion-context.js';
import {getMotionStylesTool} from '../vendor/figwright/packages/mcp/src/tools/get-motion-styles.js';
import {getNodeMotionTool} from '../vendor/figwright/packages/mcp/src/tools/get-node-motion.js';
import {getNodeTool} from '../vendor/figwright/packages/mcp/src/tools/get-node.js';
import {getNodesInfoTool} from '../vendor/figwright/packages/mcp/src/tools/get-nodes-info.js';
import {getPagesTool} from '../vendor/figwright/packages/mcp/src/tools/get-pages.js';
import {getReactionsTool} from '../vendor/figwright/packages/mcp/src/tools/get-reactions.js';
import {getScreenshotTool} from '../vendor/figwright/packages/mcp/src/tools/get-screenshot.js';
import {getStylesTool} from '../vendor/figwright/packages/mcp/src/tools/get-styles.js';
import {getVariableDefsTool} from '../vendor/figwright/packages/mcp/src/tools/get-variable-defs.js';
import {getVectorTool} from '../vendor/figwright/packages/mcp/src/tools/get-vector.js';
import {getViewportTool} from '../vendor/figwright/packages/mcp/src/tools/get-viewport.js';
import {importImageTool} from '../vendor/figwright/packages/mcp/src/tools/import-image.js';
import {importStyleTool} from '../vendor/figwright/packages/mcp/src/tools/import-style.js';
import {importSvgTool} from '../vendor/figwright/packages/mcp/src/tools/import-svg.js';
import {importVariableTool} from '../vendor/figwright/packages/mcp/src/tools/import-variable.js';
import {lockNodesTool} from '../vendor/figwright/packages/mcp/src/tools/lock-nodes.js';
import {moveNodesTool} from '../vendor/figwright/packages/mcp/src/tools/move-nodes.js';
import {navigateToPageTool} from '../vendor/figwright/packages/mcp/src/tools/navigate-to-page.js';
import {outlineStrokeTool} from '../vendor/figwright/packages/mcp/src/tools/outline-stroke.js';
import {pingTool} from './figwright-ping.js';
import {removeAnimationStyleTool} from '../vendor/figwright/packages/mcp/src/tools/remove-animation-style.js';
import {removeManualKeyframeTrackTool} from '../vendor/figwright/packages/mcp/src/tools/remove-manual-keyframe-track.js';
import {removeReactionsTool} from '../vendor/figwright/packages/mcp/src/tools/remove-reactions.js';
import {renamePageTool} from '../vendor/figwright/packages/mcp/src/tools/rename-page.js';
import {renameVariableTool} from '../vendor/figwright/packages/mcp/src/tools/rename-variable.js';
import {repeatNodesTool} from '../vendor/figwright/packages/mcp/src/tools/repeat-nodes.js';
import {resizeNodesTool} from '../vendor/figwright/packages/mcp/src/tools/resize-nodes.js';
import {rotateNodesTool} from '../vendor/figwright/packages/mcp/src/tools/rotate-nodes.js';
import {saveImageFillsTool} from '../vendor/figwright/packages/mcp/src/tools/save-image-fills.js';
import {saveScreenshotsTool} from '../vendor/figwright/packages/mcp/src/tools/save-screenshots.js';
import {setArcTool} from '../vendor/figwright/packages/mcp/src/tools/set-arc.js';
import {setAutoLayoutTool} from '../vendor/figwright/packages/mcp/src/tools/set-auto-layout.js';
import {setBlendModeTool} from '../vendor/figwright/packages/mcp/src/tools/set-blend-mode.js';
import {setComplexStrokeTool} from '../vendor/figwright/packages/mcp/src/tools/set-complex-stroke.js';
import {setConstraintsTool} from '../vendor/figwright/packages/mcp/src/tools/set-constraints.js';
import {setEffectsTool} from '../vendor/figwright/packages/mcp/src/tools/set-effects.js';
import {setFillsTool} from '../vendor/figwright/packages/mcp/src/tools/set-fills.js';
import {setImageFillTool} from '../vendor/figwright/packages/mcp/src/tools/set-image-fill.js';
import {setInstancePropertiesTool} from '../vendor/figwright/packages/mcp/src/tools/set-instance-properties.js';
import {setLayoutGridsTool} from '../vendor/figwright/packages/mcp/src/tools/set-layout-grids.js';
import {setLayoutPropsTool} from '../vendor/figwright/packages/mcp/src/tools/set-layout-props.js';
import {setMaskTool} from '../vendor/figwright/packages/mcp/src/tools/set-mask.js';
import {setNodeVariableModeTool} from '../vendor/figwright/packages/mcp/src/tools/set-node-variable-mode.js';
import {setOpacityTool} from '../vendor/figwright/packages/mcp/src/tools/set-opacity.js';
import {setPositionTool} from '../vendor/figwright/packages/mcp/src/tools/set-position.js';
import {setReactionsTool} from '../vendor/figwright/packages/mcp/src/tools/set-reactions.js';
import {setRepeatTool} from '../vendor/figwright/packages/mcp/src/tools/set-repeat.js';
import {setStrokesTool} from '../vendor/figwright/packages/mcp/src/tools/set-strokes.js';
import {setTextPathTool} from '../vendor/figwright/packages/mcp/src/tools/set-text-path.js';
import {setTextPropertiesTool} from '../vendor/figwright/packages/mcp/src/tools/set-text-properties.js';
import {setTextRangeTool} from '../vendor/figwright/packages/mcp/src/tools/set-text-range.js';
import {setTextTool} from '../vendor/figwright/packages/mcp/src/tools/set-text.js';
import {setTimelineDurationTool} from '../vendor/figwright/packages/mcp/src/tools/set-timeline-duration.js';
import {setVariableCodeSyntaxTool} from '../vendor/figwright/packages/mcp/src/tools/set-variable-code-syntax.js';
import {setVariableValueTool} from '../vendor/figwright/packages/mcp/src/tools/set-variable-value.js';
import {setVectorTool} from '../vendor/figwright/packages/mcp/src/tools/set-vector.js';
import {swapComponentTool} from '../vendor/figwright/packages/mcp/src/tools/swap-component.js';
import {unlockNodesTool} from '../vendor/figwright/packages/mcp/src/tools/unlock-nodes.js';
import {updateEffectStyleTool} from '../vendor/figwright/packages/mcp/src/tools/update-effect-style.js';
import {updateFlowsTool} from '../vendor/figwright/packages/mcp/src/tools/update-flows.js';
import {updatePaintStyleTool} from '../vendor/figwright/packages/mcp/src/tools/update-paint-style.js';
import {updateTextStyleTool} from '../vendor/figwright/packages/mcp/src/tools/update-text-style.js';
import {updateVariableCollectionTool} from '../vendor/figwright/packages/mcp/src/tools/update-variable-collection.js';

export const figwrightTools = [
  {spec:addComponentPropertyTool, name:'add_component_property'},
  {spec:addPageTool, name:'add_page'},
  {spec:addVariableModeTool, name:'add_variable_mode'},
  {spec:alignNodesTool, name:'align_nodes'},
  {spec:applyAnimationStyleTool, name:'apply_animation_style'},
  {spec:applyManualKeyframeTrackTool, name:'apply_manual_keyframe_track'},
  {spec:applyStyleToNodeTool, name:'apply_style_to_node'},
  {spec:bindComponentPropertyTool, name:'bind_component_property'},
  {spec:bindVariableToNodeTool, name:'bind_variable_to_node'},
  {spec:bindVariableToPaintTool, name:'bind_variable_to_paint'},
  {spec:booleanNodesTool, name:'boolean_nodes'},
  {spec:combineAsVariantsTool, name:'combine_as_variants'},
  {spec:createComponentTool, name:'create_component'},
  {spec:createEffectStyleTool, name:'create_effect_style'},
  {spec:createEllipseTool, name:'create_ellipse'},
  {spec:createGridStyleTool, name:'create_grid_style'},
  {spec:createInstanceTool, name:'create_instance'},
  {spec:createPaintStyleTool, name:'create_paint_style'},
  {spec:createShapeTool, name:'create_shape'},
  {spec:createTextPathTool, name:'create_text_path'},
  {spec:createTextStyleTool, name:'create_text_style'},
  {spec:createVariableCollectionTool, name:'create_variable_collection'},
  {spec:createVariableTool, name:'create_variable'},
  {spec:createVectorTool, name:'create_vector'},
  {spec:deleteComponentPropertyTool, name:'delete_component_property'},
  {spec:deleteNodesTool, name:'delete_nodes'},
  {spec:deletePageTool, name:'delete_page'},
  {spec:deleteStyleTool, name:'delete_style'},
  {spec:deleteVariableCollectionTool, name:'delete_variable_collection'},
  {spec:deleteVariableModeTool, name:'delete_variable_mode'},
  {spec:deleteVariableTool, name:'delete_variable'},
  {spec:detachInstanceTool, name:'detach_instance'},
  {spec:editComponentPropertyTool, name:'edit_component_property'},
  {spec:exportPdfTool, name:'export_pdf'},
  {spec:exportVideoTool, name:'export_video'},
  {spec:findReplaceTextTool, name:'find_replace_text'},
  {spec:flattenNodesTool, name:'flatten_nodes'},
  {spec:flipNodesTool, name:'flip_nodes'},
  {spec:getAnnotationsTool, name:'get_design_annotations'},
  {spec:getComponentApiTool, name:'get_component_api'},
  {spec:getDesignContextTool, name:'get_design_context'},
  {spec:getDocumentTool, name:'get_document'},
  {spec:getFontsTool, name:'get_fonts'},
  {spec:getLocalComponentsTool, name:'get_design_components'},
  {spec:getMetadataTool, name:'get_metadata'},
  {spec:getMotionContextTool, name:'get_motion_context'},
  {spec:getMotionStylesTool, name:'get_motion_styles'},
  {spec:getNodeMotionTool, name:'get_node_motion'},
  {spec:getNodeTool, name:'get_node'},
  {spec:getNodesInfoTool, name:'get_design_nodes'},
  {spec:getPagesTool, name:'get_pages'},
  {spec:getReactionsTool, name:'get_prototype_reactions'},
  {spec:getScreenshotTool, name:'get_screenshot'},
  {spec:getStylesTool, name:'get_design_styles'},
  {spec:getVariableDefsTool, name:'get_variable_defs'},
  {spec:getVectorTool, name:'get_vector'},
  {spec:getViewportTool, name:'get_viewport'},
  {spec:importImageTool, name:'import_image'},
  {spec:importStyleTool, name:'import_style'},
  {spec:importSvgTool, name:'import_svg'},
  {spec:importVariableTool, name:'import_variable'},
  {spec:lockNodesTool, name:'lock_nodes'},
  {spec:moveNodesTool, name:'move_nodes'},
  {spec:navigateToPageTool, name:'navigate_to_page'},
  {spec:outlineStrokeTool, name:'outline_stroke'},
  {spec:pingTool, name:'ping'},
  {spec:removeAnimationStyleTool, name:'remove_animation_style'},
  {spec:removeManualKeyframeTrackTool, name:'remove_manual_keyframe_track'},
  {spec:removeReactionsTool, name:'remove_reactions'},
  {spec:renamePageTool, name:'rename_page'},
  {spec:renameVariableTool, name:'rename_variable'},
  {spec:repeatNodesTool, name:'repeat_nodes'},
  {spec:resizeNodesTool, name:'resize_nodes'},
  {spec:rotateNodesTool, name:'rotate_nodes'},
  {spec:saveImageFillsTool, name:'save_image_fills'},
  {spec:saveScreenshotsTool, name:'save_screenshots'},
  {spec:setArcTool, name:'set_arc'},
  {spec:setAutoLayoutTool, name:'set_auto_layout'},
  {spec:setBlendModeTool, name:'set_blend_mode'},
  {spec:setComplexStrokeTool, name:'set_complex_stroke'},
  {spec:setConstraintsTool, name:'set_constraints'},
  {spec:setEffectsTool, name:'set_effects'},
  {spec:setFillsTool, name:'set_fills'},
  {spec:setImageFillTool, name:'set_design_image_fill'},
  {spec:setInstancePropertiesTool, name:'set_instance_properties'},
  {spec:setLayoutGridsTool, name:'set_layout_grids'},
  {spec:setLayoutPropsTool, name:'set_layout_props'},
  {spec:setMaskTool, name:'set_mask'},
  {spec:setNodeVariableModeTool, name:'set_node_variable_mode'},
  {spec:setOpacityTool, name:'set_opacity'},
  {spec:setPositionTool, name:'set_position'},
  {spec:setReactionsTool, name:'set_reactions'},
  {spec:setRepeatTool, name:'set_repeat'},
  {spec:setStrokesTool, name:'set_strokes'},
  {spec:setTextPathTool, name:'set_text_path'},
  {spec:setTextPropertiesTool, name:'set_text_properties'},
  {spec:setTextRangeTool, name:'set_text_range'},
  {spec:setTextTool, name:'set_text'},
  {spec:setTimelineDurationTool, name:'set_timeline_duration'},
  {spec:setVariableCodeSyntaxTool, name:'set_variable_code_syntax'},
  {spec:setVariableValueTool, name:'set_variable_value'},
  {spec:setVectorTool, name:'set_vector'},
  {spec:swapComponentTool, name:'swap_component'},
  {spec:unlockNodesTool, name:'unlock_nodes'},
  {spec:updateEffectStyleTool, name:'update_effect_style'},
  {spec:updateFlowsTool, name:'update_flows'},
  {spec:updatePaintStyleTool, name:'update_paint_style'},
  {spec:updateTextStyleTool, name:'update_text_style'},
  {spec:updateVariableCollectionTool, name:'update_variable_collection'},
];
