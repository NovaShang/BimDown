/**
 * Built-in starter type catalog (metric) that new projects get: path → CSV.
 * Identical to bimdown-spec/spec/starter-types/global/*.csv (the CLI's `init`
 * copies those); web/src/lib/starter-types.test.ts keeps the two in sync.
 * Plain data so the API Worker can import it too.
 */
export const STARTER_TYPE_FILES = {
  'global/beam_type.csv': `id,name,description,material,shape,size_x,size_y,flange,web,thickness
bmt-concrete-250x500,Concrete 250 x 500,,concrete,rect,0.25,0.5,,,
bmt-concrete-300x600,Concrete 300 x 600,,concrete,rect,0.3,0.6,,,
bmt-steel-ipe-300,Steel IPE 300,European I-beam,steel,i_shape,0.15,0.3,0.0107,0.0071,
bmt-glulam-200x400,Glulam 200 x 400,Glued laminated timber,wood,rect,0.2,0.4,,,
`,
  'global/ceiling_type.csv': `id,name,description,material,thickness
clt-gypsum-board,Gypsum board 12.5,Suspended plasterboard ceiling,gypsum,0.0125
clt-acoustic-tile,Acoustic tile 600 x 600,Mineral fibre lay-in tiles,composite,0.02
`,
  'global/column_type.csv': `id,name,description,material,shape,size_x,size_y,flange,web,thickness
colt-concrete-400,Concrete 400 x 400,,concrete,rect,0.4,0.4,,,
colt-concrete-600,Concrete 600 x 600,,concrete,rect,0.6,0.6,,,
colt-concrete-round-400,Concrete round 400,,concrete,round,0.4,,,,
colt-steel-hea-300,Steel HEA 300,European wide-flange section,steel,i_shape,0.3,0.29,0.014,0.0085,
`,
  'global/curtain_wall_type.csv': `id,name,description,material,u_spacing,v_spacing,panel_material,u_value,shgc,vt
cwt-glazed-1500,Glazed 1500 grid,Aluminium stick system with double-glazed panels,aluminum,1.5,1.5,glass,1.6,0.35,0.6
`,
  'global/door_type.csv': `id,name,description,material,width,height,operation,frame_width,u_value,shgc,vt
dt-single-900,Single 900 x 2100,Flush timber door,wood,0.9,2.1,single_swing,0.05,2.0,,
dt-single-1000,Single 1000 x 2100,Accessible flush timber door,wood,1.0,2.1,single_swing,0.05,2.0,,
dt-double-1800,Double 1800 x 2100,Pair of flush timber leaves,wood,1.8,2.1,double_swing,0.05,2.0,,
dt-ext-1000,Exterior insulated 1000 x 2200,Insulated entrance door,aluminum,1.0,2.2,single_swing,0.07,1.3,,
dt-sliding-glass-2400,Sliding glass 2400 x 2100,Double-glazed aluminium patio door,aluminum,2.4,2.1,sliding,0.07,1.6,0.45,0.6
`,
  'global/roof_type.csv': `id,name,description,material,thickness
rot-flat-insulated,Flat roof - Membrane + PIR 150 on concrete 200,Warm flat roof: waterproofing on PIR insulation on a concrete deck with plaster soffit,concrete,0.37
rot-pitched-tile,Pitched roof - Tiles on insulated rafters,Clay tiles on battens over timber rafters filled with mineral wool,wood,0.25
`,
  'global/slab_type.csv': `id,name,description,material,thickness
slt-concrete-200,Concrete 200,Plain concrete slab,concrete,0.2
slt-floor-tile,Floor - Tile + screed on concrete 200,Ceramic tile on cement screed on a concrete slab,concrete,0.26
slt-ground-insulated,Ground floor - Screed + XPS 100 on concrete 200,Screed on XPS insulation and damp-proof membrane on a concrete slab,concrete,0.362
`,
  'global/type_layer.csv': `id,type_id,seq,function,material,thickness,conductivity,name
tl-1,wt-concrete-200,1,core,concrete,0.2,2.3,Reinforced concrete
tl-2,wt-ext-concrete-eps,1,finish,composite,0.01,0.7,Exterior render
tl-3,wt-ext-concrete-eps,2,insulation,insulation,0.1,0.035,EPS 100
tl-4,wt-ext-concrete-eps,3,core,concrete,0.2,2.3,Reinforced concrete
tl-5,wt-ext-concrete-eps,4,finish,gypsum,0.015,0.4,Gypsum plaster
tl-6,wt-ext-brick-cavity,1,finish,brick,0.1,0.77,Facing brick
tl-7,wt-ext-brick-cavity,2,air_gap,,0.04,,Ventilated cavity
tl-8,wt-ext-brick-cavity,3,insulation,insulation,0.05,0.035,Mineral wool
tl-9,wt-ext-brick-cavity,4,core,brick,0.1,0.77,Brick inner leaf
tl-10,wt-ext-brick-cavity,5,finish,gypsum,0.01,0.4,Gypsum plaster
tl-11,wt-ext-timber-frame,1,finish,fiber_cement,0.015,0.35,Fibre-cement cladding
tl-12,wt-ext-timber-frame,2,air_gap,,0.025,,Battens and ventilation
tl-13,wt-ext-timber-frame,3,core,wood,0.145,0.045,Timber studs with mineral wool
tl-14,wt-ext-timber-frame,4,finish,gypsum,0.015,0.25,Gypsum board
tl-15,wt-int-stud-100,1,finish,gypsum,0.0125,0.25,Gypsum board
tl-16,wt-int-stud-100,2,core,insulation,0.075,0.04,Steel studs with mineral wool
tl-17,wt-int-stud-100,3,finish,gypsum,0.0125,0.25,Gypsum board
tl-18,wt-int-masonry-150,1,finish,gypsum,0.015,0.4,Gypsum plaster
tl-19,wt-int-masonry-150,2,core,brick,0.12,0.6,Brick
tl-20,wt-int-masonry-150,3,finish,gypsum,0.015,0.4,Gypsum plaster
tl-21,wt-concrete-300,1,core,concrete,0.3,2.3,Reinforced concrete
tl-22,slt-concrete-200,1,core,concrete,0.2,2.3,Reinforced concrete
tl-23,slt-floor-tile,1,finish,ceramic,0.01,1.3,Ceramic tile
tl-24,slt-floor-tile,2,substrate,concrete,0.05,1.4,Cement screed
tl-25,slt-floor-tile,3,core,concrete,0.2,2.3,Reinforced concrete
tl-26,slt-ground-insulated,1,substrate,concrete,0.06,1.4,Cement screed
tl-27,slt-ground-insulated,2,insulation,insulation,0.1,0.034,XPS
tl-28,slt-ground-insulated,3,membrane,pvc,0.002,0.17,Damp-proof membrane
tl-29,slt-ground-insulated,4,core,concrete,0.2,2.3,Reinforced concrete
tl-30,rot-flat-insulated,1,membrane,pvc,0.005,0.17,Waterproofing membrane
tl-31,rot-flat-insulated,2,insulation,insulation,0.15,0.022,PIR
tl-32,rot-flat-insulated,3,core,concrete,0.2,2.3,Reinforced concrete
tl-33,rot-flat-insulated,4,finish,gypsum,0.015,0.4,Gypsum plaster
tl-34,rot-pitched-tile,1,finish,ceramic,0.025,1,Clay tiles
tl-35,rot-pitched-tile,2,air_gap,,0.025,,Battens and ventilation
tl-36,rot-pitched-tile,3,core,wood,0.18,0.045,Rafters with mineral wool
tl-37,rot-pitched-tile,4,finish,gypsum,0.02,0.25,Gypsum board
tl-38,clt-gypsum-board,1,finish,gypsum,0.0125,0.25,Gypsum board
tl-39,clt-acoustic-tile,1,finish,composite,0.02,0.05,Mineral fibre tile
`,
  'global/wall_type.csv': `id,name,description,material,thickness
wt-concrete-200,Concrete 200,Plain cast-in-place concrete wall,concrete,0.2
wt-ext-concrete-eps,Exterior - Concrete 200 + EPS 100,Render on EPS insulation on a concrete core with interior plaster,concrete,0.325
wt-ext-brick-cavity,Exterior - Brick cavity 300,Brick outer leaf; ventilated cavity; mineral wool; brick inner leaf; plaster,brick,0.3
wt-ext-timber-frame,Exterior - Timber frame 200,Fibre-cement cladding on battens; insulated timber studs; gypsum board,wood,0.2
wt-int-stud-100,Interior - Stud partition 100,Gypsum board on both sides of steel studs with mineral wool,gypsum,0.1
wt-int-masonry-150,Interior - Masonry 120 + plaster,Brick or block wall plastered on both sides,brick,0.15
wt-concrete-300,Concrete 300,Structural or core concrete wall,concrete,0.3
`,
  'global/window_type.csv': `id,name,description,material,width,height,operation,frame_width,u_value,shgc,vt
wnt-casement-600x1200,Casement 600 x 1200,Double-glazed aluminium casement,aluminum,0.6,1.2,casement,0.06,1.4,0.4,0.6
wnt-casement-1200x1500,Casement 1200 x 1500,Double-glazed aluminium casement,aluminum,1.2,1.5,casement,0.06,1.4,0.4,0.6
wnt-fixed-1800x1500,Fixed 1800 x 1500,Double-glazed fixed light,aluminum,1.8,1.5,fixed,0.05,1.3,0.4,0.65
wnt-sliding-1500x1200,Sliding 1500 x 1200,Double-glazed aluminium slider,aluminum,1.5,1.2,sliding,0.06,1.6,0.45,0.6
wnt-tilt-turn-900x1400,Tilt and turn 900 x 1400,Triple-glazed PVC tilt-and-turn,pvc,0.9,1.4,tilt_and_turn,0.08,0.9,0.35,0.55
`,
};
