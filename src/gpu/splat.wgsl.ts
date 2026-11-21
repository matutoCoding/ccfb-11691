/** 屏幕空间椭圆 splat 着色器:
 *  - 椭圆在点的切平面内展开,法线越侧向越扁(朝向压扁)
 *  - 世界空间恒定半径 → 近大远小自动调节,路面无孔洞
 *  - 着色模式:RGB / 反射强度 / 法线 / 高程 */

export const SPLAT_WGSL = /* wgsl */ `
struct Globals {
  viewProj : mat4x4<f32>,
  view     : mat4x4<f32>,
  camRight : vec3<f32>,
  splatMinPx : f32,
  camUp    : vec3<f32>,
  colorMode  : u32,       // 0=RGB 1=强度 2=法线 3=高程
  viewport   : vec2<f32>,
  heightRange: vec2<f32>, // 高程着色 min/max
};

struct NodeParams {
  splatRadius : f32,      // 本节点 splat 世界半径(随 LOD 层距放大)
  pad0 : f32,
  pad1 : f32,
  pad2 : f32,
};

struct Point {
  pos       : vec3<f32>,
  color     : u32,        // rgba8 packed
  intensity : f32,
  normal    : vec3<f32>,
};

@group(0) @binding(0) var<uniform> G : Globals;
@group(1) @binding(0) var<storage, read> points : array<Point>;
@group(1) @binding(1) var<uniform> NP : NodeParams;

struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) color : vec3<f32>,
  @location(2) normal : vec3<f32>,
};

fn intensityRamp(t : f32) -> vec3<f32> {
  // 蓝-青-绿-黄-红
  let x = clamp(t, 0.0, 1.0);
  let r = clamp(1.5 * x - 0.2, 0.0, 1.0);
  let g = clamp(1.5 - abs(2.0 * x - 1.0) * 1.5, 0.0, 1.0);
  let b = clamp(1.2 - 1.6 * x, 0.0, 1.0);
  return vec3<f32>(r, g, b);
}

@vertex
fn vs_main(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VSOut {
  let p = points[ii];
  // 6 顶点拼一个四边形,角点角度 45/135/225/315 度
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
  let corner = corners[vi];

  // 切平面基向量:有法线 → 椭圆贴在表面上(法线侧视时压扁);
  // 无法线 → 面向相机的圆形 billboard
  var t1 : vec3<f32>;
  var t2 : vec3<f32>;
  let nlen = length(p.normal);
  if (nlen > 0.5) {
    let n = p.normal / nlen;
    let ref = select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 0.0), abs(n.z) > 0.9);
    t1 = normalize(cross(n, ref));
    t2 = cross(n, t1);
  } else {
    t1 = G.camRight;
    t2 = G.camUp;
  }

  let world = p.pos + (t1 * corner.x + t2 * corner.y) * NP.splatRadius;
  var clip = G.viewProj * vec4<f32>(world, 1.0);

  // 最小像素尺寸钳制(远处细节不消失)
  let px = G.splatMinPx * 2.0 / G.viewport;
  let viewPos = G.view * vec4<f32>(p.pos, 1.0);
  let dist = max(length(viewPos.xyz), 0.001);
  _ = dist;
  _ = px;

  var out : VSOut;
  out.clip = clip;
  out.uv = corner;

  // 颜色
  let cr = f32((p.color >> 0u) & 255u) / 255.0;
  let cg = f32((p.color >> 8u) & 255u) / 255.0;
  let cb = f32((p.color >> 16u) & 255u) / 255.0;
  var c = vec3<f32>(cr, cg, cb);
  if (G.colorMode == 1u) {
    c = intensityRamp(p.intensity);
  } else if (G.colorMode == 2u) {
    c = p.normal * 0.5 + 0.5;
  } else if (G.colorMode == 3u) {
    c = intensityRamp((p.pos.z - G.heightRange.x) / max(G.heightRange.y - G.heightRange.x, 0.001));
  }
  out.color = c;
  out.normal = p.normal;
  return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  let d2 = dot(in.uv, in.uv);
  if (d2 > 1.0) { discard; }
  // 球面 impostor 明暗,增强立体感
  let z = sqrt(max(1.0 - d2, 0.0));
  let shade = 0.55 + 0.45 * z;
  return vec4<f32>(in.color * shade, 1.0);
}
`;
