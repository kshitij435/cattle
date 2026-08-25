// =========================================================================
// STEP DEFINITIONS -- extracted from the original index.html verbatim.
// =========================================================================
const DEAD_STEPS = [
  { id:"flank", label:"Flank", sided:true, required:true, domain:"dead",
    variants:{left:"left_flank", right:"right_flank"},
    hint:"Stand to the animal's visible side, fit the full body in the outline" },
  { id:"head", label:"Head", sided:true, required:true, domain:"dead",
    variants:{left:"front_view_left", right:"front_view_right"},
    secondaryModel:true,   // also runs the horns/ear_tag model alongside head orientation, see SECONDARY_MODEL_CONFIG
    hint:"Capture the head from whichever angle is visible, fill the outline" },
  { id:"muzzle", label:"Muzzle", sided:false, required:true, domain:"dead", border:"muzzle",
    hint:"Get close to the nose, fill the outline with the muzzle" },
  { id:"ear_tag", label:"Ear Tag", sided:false, required:true, domain:"dead", border:"ear_tag",
    hint:"Get close to the ear tag, keep the numbers readable" },
  { id:"owner_photo", label:"Owner Photo", sided:false, required:true, domain:"dead", freeform:true,
    hint:"Photograph the owner with the animal — tap capture when ready" },
  { id:"video", label:"Video", sided:false, required:true, domain:"dead", video:true,
    hint:"Tap to record a 60 second video of the animal" },
  { id:"scar_injury", label:"Scar/Injury", sided:false, required:false, domain:"dead", freeform:true,
    hint:"Optional — capture any visible scar or injury, tap capture when ready" },
  { id:"geotag", label:"Geotag", sided:false, required:true, domain:"dead", geotag:true, geotagSource:"flank",
    hint:"Tap to generate a geotagged version of your Flank photo" },
];

// ---- LIVE CATTLE (underwriting documentation) ----
const LIVE_STEPS = [
  { id:"flank_live", label:"Flank", sided:true, required:true, domain:"live",
    variants:{left:"left_side_live", right:"right_side_live"},
    hint:"Stand to the animal's visible side, keep the whole body in frame" },
  { id:"front_view_live", label:"Front Head", sided:false, required:true, domain:"live", border:"front_head_live",
    secondaryModel:true,   // also runs the horns/ear_tag model alongside front head, see SECONDARY_MODEL_CONFIG
    hint:"Face the animal's head directly, keep it centered in frame" },
  { id:"rear_view_live", label:"Rear View", sided:false, required:true, domain:"live", border:"rear_view_live",
    hint:"Stand directly behind the animal, fit rump and legs in frame" },
  { id:"muzzle_live", label:"Muzzle", sided:false, required:true, domain:"live", border:"muzzle",
    hint:"Get close to the nose, fill the outline with the muzzle" },
  { id:"ear_tag_live", label:"Ear Tag", sided:false, required:true, domain:"live", border:"ear_tag",
    hint:"Get close to the ear tag, keep the numbers readable" },
  { id:"owner_photo_live", label:"Owner Photo", sided:false, required:true, domain:"live", freeform:true,
    hint:"Photograph the owner with the animal — tap capture when ready" },
  { id:"video_live", label:"Video", sided:false, required:true, domain:"live", video:true,
    hint:"Tap to record a 60 second video of the animal" },
  { id:"scar_injury_live", label:"Scar/Injury", sided:false, required:false, domain:"live", freeform:true,
    hint:"Optional — capture any visible scar or injury, tap capture when ready" },
  { id:"geotag_live", label:"Geotag", sided:false, required:true, domain:"live", geotag:true, geotagSource:"flank_live",
    hint:"Tap to generate a geotagged version of your Flank photo" },
];

export { DEAD_STEPS, LIVE_STEPS };
