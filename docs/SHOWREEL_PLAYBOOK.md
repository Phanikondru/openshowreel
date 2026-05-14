# Showreel playbook

How to drive the OpenShowreel tools to build a polished product reel — the sequence and the taste rules that separate "a computer made this" from "a designer made this".

## 0. Inputs that matter
Tools are primitives; a great reel still needs **real assets**: product screenshots / screen recordings, a logo, the brand font (PostScript name), copy, and ideally a music track. Pure shape-layer UI looks generic — composite actual screenshots inside device frames instead.

## 1. Foundation
- `ae_setup_comp` — 1920×1080, **60 fps, motion blur on**. This is non-negotiable for the "buttery" feel.
- `ae_create_solid` for the background (a near-black or brand colour).
- `ae_add_markers` at every beat / section change (drop them on the music). Everything downstream snaps to these times.

## 2. Build scenes as precomps
Each "feature" gets its own scene:
- `ae_import_media` the screenshot/recording → `ae_add_device_frame` (browser/phone/card) so it reads as a real product.
- `ae_create_shape` / `ae_create_text` for callouts, highlights, captions.
- `ae_create_precomp` the whole thing into `Scene 1`, `Scene 2`, … then `ae_add_layer_to_comp` to lay them on the main timeline at the marker times.

## 3. Motion grammar (apply to every animated element)
- **In/out**: `ae_animate_transform` position+scale with `easing: "easeOut"` for entrances, `easeIn` for exits; `ae_add_fade` for opacity. Never linear.
- **Overshoot**: `ae_add_bounce_expression` on scale/position of hero elements — a little spring on arrival.
- **Anticipation**: `ae_add_button_press` before a major move (a UI element "presses" before it flies).
- **Stagger**: nested elements `ae_add_timing_offset` ~0.06–0.12 s behind their parent. Text uses `ae_add_text_reveal` (per character). Nothing moves in unison.
- **Paths**: travelling elements use `ae_create_null_path` with a *curved* path — straight lines look mechanical.
- **Reveals**: wipe content on with `ae_add_mask` + `ae_animate_mask` (expansion), or `ae_set_track_matte`; draw lines/underlines on with `ae_add_trim_path`.

## 4. Depth & polish
- `ae_add_drop_shadow` on cards/frames (soft, ~45% opacity, large blur).
- `ae_add_glow` on the logo / key highlights; `ae_set_blend_mode` "add"/"screen" for light leaks.
- `ae_add_gaussian_blur` keyframed for focus pulls between scenes (blur up → cut → blur down).
- Speed ramps on screen recordings: `ae_enable_time_remap` + `ae_animate_time_remap` (ease into a hold on the important UI state, then accelerate past the boring bits).

## 5. Camera
- `ae_set_layer_3d` (allLayers: true) → `ae_add_camera` → `ae_animate_camera` for a slow push-in within a scene, or a parallax pan. Subtle: a few hundred px of Z over a couple of seconds. Easing `easeOut`.

## 6. The cinematic stitch
- After everything is placed: `ae_add_master_camera` over the whole comp — a barely-perceptible tilt (≈1–1.5°, positive→negative) so the entire reel breathes as one piece.
- One top-level `ae_add_adjustment_layer` with a grade (Curves / a slight vignette via a feathered inverted mask + black fill at low opacity).

## 7. Review & ship
- `ae_render_frames` at the marker times → look at the PNGs → adjust. Iterate.
- `ae_render_comp` to a `.mov`/`.mp4` when it's right. `ae_save_project` along the way.

## Taste rules (the short version)
1. 60 fps + motion blur, always.
2. No linear keyframes. Ease everything.
3. Nothing moves at the same time as its neighbour — stagger by a beat.
4. Curves over straight lines for motion paths.
5. Anticipation before big moves; overshoot on arrival.
6. Real screenshots in device frames > hand-built shape mockups.
7. Cut/transition on the beat — that's why the markers go down first.
8. A whisper of camera move and a global tilt at the end — never a lot.
