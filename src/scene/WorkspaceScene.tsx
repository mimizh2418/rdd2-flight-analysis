import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Quat, Run } from '../data/types';
import { attitude, sample, upperBound, vector } from '../playback/time';
import { usePlayback } from '../playback/PlaybackProvider';
import { fromRpy, toRpy } from '../math/rotation';
import { fieldValue, findField } from '../workspace/fieldCatalog';
import type { Binding, Field, PreparedField, ViewTab } from '../workspace/types';
import { followablePoses, spatialLayers } from '../workspace/spatial';
import { drone, updateModelAttitude } from './models';
import { CameraTransition } from './cameraTransition';
import { visualizationTheme } from '../theme';
import { FollowPoseMenu } from '../components/FollowPoseMenu';

const cameras = new Map<
  string,
  {
    position: THREE.Vector3;
    target: THREE.Vector3;
    extent: string;
    mode: ViewTab['camera'];
    follow: boolean;
    followPose?: string;
    quaternion: THREE.Quaternion;
    rendered: THREE.PerspectiveCamera;
    transition: CameraTransition;
  }
>();
const nominalRotors = [
  [0.17678, -0.17678, 0],
  [-0.17678, -0.17678, 0],
  [-0.17678, 0.17678, 0],
  [0.17678, 0.17678, 0],
];

/**
 * Sample a pose's explicit or native attitude from the correct independently aligned source.
 * @param binding Pose settings.
 * @param field Pose/orientation metadata.
 * @param fields Loaded catalog.
 * @param runs Source registry.
 * @param offsets Per-source display offsets.
 * @param time Global effective displayed seconds.
 * @returns Normalized x/y/z/w quaternion, or all-NaN when attitude is missing/invalid.
 * @remarks Reference positions default to logged, held yaw with zero roll/pitch. Missing reference yaw uses a
 *   fixed level heading. Explicit orientation overrides always take precedence over that display convention.
 */
export function bindingAttitude(
  binding: Binding,
  field: Field,
  fields: Field[],
  runs: Run[],
  offsets: Map<string, number>,
  time: number,
): Quat {
  const orientation = binding.orientation
    ? findField(fields, binding.orientation.runId, binding.orientation.fieldId)
    : field;
  const prefix = binding.orientation
    ? orientation?.prefix
    : field.type === 'orientation'
      ? field.prefix
      : field.orientation;
  const runId = binding.orientation?.runId ?? binding.runId;
  const run = runs.find((item) => item.id === runId);
  const offset = offsets.get(runId);

  if (!binding.orientation && field.prefix === 'reference.position' && run && Number.isFinite(offset)) {
    const yaw = sample(run, 'reference.yaw', time + offset!);

    // Reference guidance supplies heading rather than full attitude. Keep the marker level without smoothing.
    return fromRpy([0, 0, Number.isFinite(yaw) ? yaw : 0]);
  }

  return prefix && run && Number.isFinite(offset) ? attitude(run, prefix, time + offset!) : [NaN, NaN, NaN, NaN];
}

/**
 * Dispose every geometry/material owned by an abandoned scene, including arrow helper resources.
 * @param scene Scene root whose resources are not shared with other tabs.
 * @returns Nothing; GPU buffers and material programs are released.
 */
function disposeScene(scene: THREE.Scene): void {
  scene.traverse((object) => {
    const drawable = object as THREE.Mesh;
    drawable.geometry?.dispose();
    const materials = drawable.material
      ? Array.isArray(drawable.material)
        ? drawable.material
        : [drawable.material]
      : [];
    materials.forEach((material) => material.dispose());
  });
}

/**
 * Render configurable trajectory layers or a centered vehicle with vectors and command overlays.
 * @param props Per-tab bindings, immutable worker geometry, and shared source references.
 * @returns Orbitable 3D viewport with scientific readouts and a recoverable WebGL fallback.
 */
export function WorkspaceScene({
  tab,
  fields,
  runs,
  prepared,
  onCameraMode,
  onFollowPose,
}: {
  tab: ViewTab;
  fields: Field[];
  runs: Run[];
  prepared: Record<string, PreparedField>;
  onCameraMode: (mode: ViewTab['camera']) => void;
  /** Select a trajectory binding and enter follow mode in one tab update. */
  onFollowPose: (bindingId: string) => void;
}) {
  const playback = usePlayback();
  const host = useRef<HTMLDivElement>(null);
  const live = useRef(playback);
  live.current = playback;
  // Camera commands are live state, not scene resources. Changing them must not replace the WebGL canvas.
  const view = useRef(tab);
  view.current = tab;
  const [failure, setFailure] = useState('');
  const [gridSpacing, setGridSpacing] = useState('');
  const controlsApi = useRef<{ fit: () => void; mode: (mode: ViewTab['camera']) => void } | null>(null);
  const vehicle = tab.type === 'vehicle';
  const followPoses = followablePoses(tab, fields);
  const selectedFollowPose = followPoses.find((binding) => binding.id === tab.followPose);

  useEffect(() => {
    const container = host.current!;
    const theme = visualizationTheme(container);
    let renderer: THREE.WebGLRenderer;

    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      setFailure('WebGL unavailable. Telemetry, graphs, and exports remain available.');
      return;
    }
    setFailure('');
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(theme.canvas);
    renderer.domElement.setAttribute('aria-label', vehicle ? 'Centered vehicle 3D view' : 'Trajectory 3D view');
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
    const renderedCamera = camera.clone();
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    // Following locks the orbit center to the moving pose while keeping rotation and zoom available.
    controls.enablePan = tab.camera !== 'follow';
    const ambient = new THREE.HemisphereLight('#d4e3f4', '#263444', 2.5);
    scene.add(ambient);
    const light = new THREE.DirectionalLight('#ffffff', 3);
    light.position.set(5, -4, 8);
    scene.add(light);

    const bounds = new THREE.Box3();
    const lines: { line: LineSegments2; binding: Binding; times: Float64Array; segments: number; run: Run }[] = [];
    const poses: { root: THREE.Group; binding: Binding; field: Field; run: Run; axes: THREE.AxesHelper }[] = [];
    const overlays: { binding: Binding; field: Field; run: Run; arrows: THREE.ArrowHelper[] }[] = [];
    const lineMaterials: LineMaterial[] = [];

    for (const binding of tab.bindings.filter((item) => item.visible)) {
      const field = findField(fields, binding.runId, binding.fieldId);
      const run = runs.find((item) => item.id === binding.runId);

      if (!field || !run || !prepared[binding.id]) continue;
      const layers = spatialLayers(binding, field);
      const path = prepared[binding.id].path;

      // Both representations share the prepared position data. Include its bounds even for pose-only fields.
      if (!vehicle && path?.bounds.min.every(Number.isFinite) && path.bounds.max.every(Number.isFinite)) {
        bounds.expandByPoint(new THREE.Vector3(...path.bounds.min));
        bounds.expandByPoint(new THREE.Vector3(...path.bounds.max));
      }

      if (!vehicle && layers.trajectory && path?.positions.length) {
        const geometry = new LineSegmentsGeometry();
        const positions = binding.fullPath ? (path.fullPositions ?? path.positions) : path.positions;
        geometry.setPositions(positions);
        const material = new LineMaterial({
          color: binding.color,
          linewidth: binding.width,
          dashed: binding.style !== 'solid',
          dashSize: binding.style === 'dotted' ? 0.03 : 0.25,
          gapSize: binding.style === 'dotted' ? 0.1 : 0.14,
          worldUnits: false,
        });
        const line = new LineSegments2(geometry, material);
        line.computeLineDistances();
        line.frustumCulled = false;
        scene.add(line);
        lines.push({ line, binding, times: path.times, segments: positions.length / 6, run });
        lineMaterials.push(material);
        if (field.type === 'plan' && binding.markers) {
          const points = run.manifest?.mission?.waypoints ?? [];

          for (const point of points) {
            const marker = new THREE.Mesh(
              new THREE.SphereGeometry(0.05, 8, 6),
              new THREE.MeshBasicMaterial({ color: binding.color }),
            );
            marker.position.set(...point);
            scene.add(marker);
          }
        }
      }

      // Position-bearing fields remain anchors for attached vectors when their model is switched off.
      const positionAnchor = !vehicle && ['pose', 'position'].includes(field.type);
      if (binding.lane === 'vehicle' || (!vehicle && layers.pose) || positionAnchor) {
        const drawModel = binding.lane === 'vehicle' || layers.pose;
        const root =
          !drawModel || binding.model === 'ball'
            ? new THREE.Group()
            : drone(
                new THREE.Color(binding.color).getHex(),
                run.manifest?.mission?.rotor_positions,
                binding.model === 'ghost',
              );

        if (drawModel && binding.model === 'ball')
          root.add(
            new THREE.Mesh(
              new THREE.SphereGeometry(0.085, 20, 16),
              new THREE.MeshStandardMaterial({ color: binding.color }),
            ),
          );
        root.scale.setScalar(binding.scale);
        const axes = new THREE.AxesHelper(0.4);
        axes.visible = vehicle && tab.bodyAxes;
        root.add(axes);
        // The generic model's own body axes are replaced by the tab's explicit body-axes overlay.
        root.userData.body?.children.forEach((child: THREE.Object3D) => {
          if (child instanceof THREE.AxesHelper) child.visible = false;
        });
        scene.add(root);
        poses.push({ root, binding, field, run, axes });
      } else if (binding.lane === 'overlays' || (!vehicle && field.type === 'velocity')) {
        const count =
          field.type === 'orientation'
            ? 3
            : field.type === 'motors' || field.type === 'rotors'
              ? 4
              : binding.componentArrows
                ? 4
                : 1;
        const arrows = Array.from(
          { length: count },
          () => new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 0.2, binding.color, 0.08, 0.04),
        );
        arrows.forEach((arrow) => scene.add(arrow));
        overlays.push({ binding, field, run, arrows });
      }
    }

    const extent = vehicle
      ? `vehicle:${poses[0]?.binding.id ?? ''}`
      : tab.bindings
          .filter((binding) => binding.visible)
          .map((binding) => `${binding.id}:${binding.runId}:${prepared[binding.id]?.path?.times.length ?? 0}`)
          .join('|');
    const radius = vehicle ? 0.6 : bounds.isEmpty() ? 2 : Math.max(1, bounds.getSize(new THREE.Vector3()).length() / 2);
    const center = vehicle || bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
    if (!vehicle) {
      const grid = new THREE.GridHelper(Math.max(2, radius * 3), 20, theme.border, theme.grid);
      setGridSpacing((Math.max(2, radius * 3) / 20).toPrecision(3));
      grid.rotation.x = Math.PI / 2;
      grid.position.set(center.x, center.y, 0);
      const ground = runs.find((run) => tab.bindings.some((binding) => binding.runId === run.id))?.manifest?.mission
        ?.ground;

      if (ground) {
        // Keep the supplied ground plane equation n·p = offset in ENU instead of assuming horizontal terrain.
        const normal = new THREE.Vector3(...ground.normal);
        const distance = normal.length();

        if (distance > 0) {
          normal.divideScalar(distance);
          grid.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
          grid.position.copy(center).addScaledVector(normal, ground.offset / distance - center.dot(normal));
        }
      }
      scene.add(grid);
    }
    const worldAxes = new THREE.AxesHelper(vehicle ? 0.65 : Math.max(0.5, radius / 4));
    worldAxes.visible = !vehicle || tab.worldAxes;
    scene.add(worldAxes);
    let followedPose =
      !vehicle && tab.camera === 'follow' ? poses.find((item) => item.binding.id === tab.followPose) : undefined;
    const followDisplacement = new THREE.Vector3();
    const saved = cameras.get(tab.id);
    const transition = saved?.transition ?? new CameraTransition();
    let currentMode = tab.camera;
    let currentFollowPose = tab.followPose;
    let currentFollowOrientation = tab.followOrientation;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /**
     * Fit full prepared path bounds, or the nominal centered vehicle, without rescanning telemetry.
     *
     * @param smooth Whether to animate from the last displayed viewpoint; startup fitting is immediate.
     * @returns Nothing; sets camera position and orbit target from prepared bounds.
     */
    const fit = (smooth = true) => {
      if (smooth) transition.start(renderedCamera);
      currentMode = 'orbit';
      controls.target.copy(center);
      camera.position.copy(center).add(new THREE.Vector3(1.4, -1.8, 1.25).multiplyScalar(radius));
      controls.update();
    };
    /**
     * Place the camera in a standard ENU view while retaining the orbit target.
     *
     * @param value Orbit, top, side, or a close follow view in the ENU frame.
     * @param smooth Whether to animate from the displayed camera; initial view setup is immediate.
     * @returns Nothing; changes destination position while retaining the current orbit target.
     */
    const mode = (value: ViewTab['camera'], smooth = true) => {
      if (smooth) transition.start(renderedCamera);
      currentMode = value;
      const direction =
        value === 'top'
          ? new THREE.Vector3(0, -0.001, 2.8)
          : value === 'side'
            ? new THREE.Vector3(0, -2.8, 0.1)
            : new THREE.Vector3(1.4, -1.8, 1.25);
      const distance = value === 'follow' ? Math.max(1, followedPose?.binding.scale ?? 1) * 2 : radius;
      camera.position.copy(controls.target).add(direction.multiplyScalar(distance));
      controls.update();
    };
    fit(false);

    if (saved && (saved.extent === extent || tab.camera === 'follow' || saved.mode === 'follow')) {
      camera.position.copy(saved.position);
      controls.target.copy(saved.target);
      renderedCamera.copy(saved.rendered);
      if (tab.camera === 'follow' && saved.followPose !== tab.followPose) transition.start(saved.rendered);
      if (vehicle && saved.follow !== tab.followOrientation) {
        transition.start(saved.rendered);
        // Convert the existing camera offset between world/body bases rather than resetting its orbit distance.
        const rotation = saved.follow ? saved.quaternion : saved.quaternion.clone().invert();
        camera.position.applyQuaternion(rotation);
      }
      controls.update();
      // Explicit toolbar presets record their destination mode before recreation; do not restart their transition.
      if (saved.mode !== tab.camera && !(saved.mode === 'follow' && tab.camera === 'orbit')) mode(tab.camera);
      currentMode = tab.camera;
    } else {
      mode(tab.camera, false);
      if (saved) transition.start(saved.rendered);
    }
    controlsApi.current = { fit: () => fit(), mode };

    const resize = new ResizeObserver(() => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      // Keep the follow menu scrollable within the clipped viewport when the dock reduces its height.
      container.parentElement?.style.setProperty('--scene-height', `${height}px`);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      lineMaterials.forEach((material) => material.resolution.set(width, height));
    });
    resize.observe(container);
    let frame = 0;
    let lost = false;
    const lastQuaternion = new THREE.Quaternion();
    /**
     * Stop rendering after WebGL context loss.
     *
     * @param event Browser WebGL context-loss event.
     * @returns Nothing; stops drawing and exposes a recoverable fallback message.
     */
    const contextLost = (event: Event) => {
      event.preventDefault();
      lost = true;
      setFailure('WebGL context lost. Switch tabs to recreate the view.');
    };
    renderer.domElement.addEventListener('webglcontextlost', contextLost);

    /**
     * Set an arrow from its physical direction, hiding missing and zero-length measurements.
     *
     * @param object Owned Three.js arrow helper to update.
     * @param origin World ENU origin in metres.
     * @param direction Physical world-frame direction and magnitude.
     * @param scale Explicit visual scale multiplier.
     * @returns Nothing; hides non-finite/zero measurements or updates arrow direction and length.
     */
    const arrow = (object: THREE.ArrowHelper, origin: THREE.Vector3, direction: THREE.Vector3, scale: number) => {
      const length = direction.length() * scale;
      object.visible = Number.isFinite(length) && length > 0.000001;
      if (!object.visible) return;
      object.position.copy(origin);
      object.setDirection(direction.clone().normalize());
      object.setLength(length, Math.min(length * 0.25, 0.12), Math.min(length * 0.12, 0.06));
    };

    /**
     * Sample only the current frame; immutable paths change their draw count rather than rebuilding geometry.
     *
     * @returns Nothing; samples the effective global time, updates transforms, and schedules the next active-view
     *   frame.
     */
    const animate = () => {
      const clock = live.current;
      const settings = view.current;
      const time = clock.effectiveTime;
      let primaryQuaternion = new THREE.Quaternion();
      let primaryPosition = new THREE.Vector3();

      // Apply new view settings inside the existing renderer. Rebuilding the scene here would discard the
      // drawing buffer and shader programs, leaving the viewport blank while the transition initializes.
      const nextPose =
        !vehicle && settings.camera === 'follow'
          ? poses.find((item) => item.binding.id === settings.followPose)
          : undefined;

      if (nextPose !== followedPose && nextPose) transition.start(renderedCamera);
      followedPose = nextPose;
      currentFollowPose = settings.followPose;

      if (settings.camera !== currentMode) {
        // Leaving follow without a preset command retains the current viewpoint.
        if (currentMode === 'follow' && settings.camera === 'orbit') currentMode = 'orbit';
        else mode(settings.camera);
      }
      controls.enablePan = currentMode !== 'follow';

      if (vehicle && settings.followOrientation !== currentFollowOrientation) {
        transition.start(renderedCamera);
        const rotation = currentFollowOrientation ? lastQuaternion : lastQuaternion.clone().invert();

        // Preserve the world viewpoint when changing between world-fixed and body-following camera bases.
        camera.position.applyQuaternion(rotation);
        currentFollowOrientation = settings.followOrientation;
      }

      for (const item of poses) {
        const offset = clock.offsets.get(item.run.id) ?? NaN;
        const attached = poses.find((pose) => pose.binding.id === item.binding.attachTo);
        const attachedOffset = attached ? (clock.offsets.get(attached.run.id) ?? NaN) : NaN;
        const position =
          item.field.type === 'orientation'
            ? attached
              ? vector(attached.run, attached.field.prefix ?? 'position', time + attachedOffset)
              : [0, 0, 0]
            : vector(item.run, item.field.prefix ?? 'position', time + offset);
        const q = bindingAttitude(item.binding, item.field, fields, runs, clock.offsets, time);
        const sourceTime = time + offset;
        const covered =
          sourceTime >= item.run.time[item.run.index[0]] &&
          sourceTime <= item.run.time[item.run.index[item.run.index.length - 1]];
        const valid = covered && position.every(Number.isFinite) && Number.isFinite(offset);
        item.root.visible = valid;
        if (!valid) continue;
        item.root.position.set(
          ...(vehicle ? ([0, 0, 0] as [number, number, number]) : (position as [number, number, number])),
        );
        // A reference drone remains a drone even with no attitude or an unavailable orientation override.
        const oriented = updateModelAttitude(item.root, q, item.field.prefix === 'reference.position');
        item.axes.visible = vehicle && tab.bodyAxes && oriented;
        if (item === poses[0]) {
          primaryQuaternion.copy(item.root.quaternion);
          primaryPosition.copy(item.root.position);
          if (oriented) lastQuaternion.copy(item.root.quaternion);
        }
      }
      for (const item of lines) {
        const offset = clock.offsets.get(item.binding.runId) ?? NaN;
        const sourceTime = time + offset;
        const staticPlan = item.times[0] === -Infinity;
        item.line.visible =
          Number.isFinite(offset) &&
          (staticPlan ||
            (sourceTime >= item.run.time[item.run.index[0]] &&
              sourceTime <= item.run.time[item.run.index[item.run.index.length - 1]]));
        item.line.geometry.instanceCount = item.binding.fullPath
          ? item.segments
          : upperBound(item.times, time + offset);
      }
      for (const item of overlays) {
        const anchor = vehicle ? poses[0] : poses.find((pose) => pose.binding.id === item.binding.attachTo);
        const origin = anchor?.root.position ?? new THREE.Vector3();
        const orientation = anchor?.root.quaternion ?? new THREE.Quaternion();
        const offset = clock.offsets.get(item.run.id) ?? NaN;
        const sourceTime = time + offset;
        item.arrows.forEach((object) => {
          object.visible = false;
        });
        if (!Number.isFinite(offset) || (anchor && !anchor.root.visible) || (item.binding.attachTo && !anchor))
          continue;
        const needsAttitude =
          ['motors', 'rotors', 'thrust'].includes(item.field.type) ||
          item.field.frame === 'FLU' ||
          item.binding.frame === 'FLU' ||
          /^bodyRate\./.test(item.field.id);
        if (needsAttitude && !anchor?.root.userData.oriented) continue;
        if (item.field.type === 'velocity') {
          const values = vector(item.run, item.field.prefix!, sourceTime);
          const direction = new THREE.Vector3(...values);

          if (item.field.frame === 'FLU') direction.applyQuaternion(orientation);
          arrow(item.arrows[0], origin, direction, item.binding.scale);
          if (item.binding.componentArrows) {
            const components =
              item.binding.frame === 'FLU'
                ? direction.clone().applyQuaternion(orientation.clone().invert())
                : direction;

            for (let axis = 0; axis < 3; axis++) {
              const component = new THREE.Vector3().setComponent(axis, components.getComponent(axis));

              if (item.binding.frame === 'FLU') component.applyQuaternion(orientation);
              arrow(item.arrows[axis + 1], origin, component, item.binding.scale);
            }
          }
        } else if (item.field.type === 'orientation') {
          const q = attitude(item.run, item.field.prefix!, sourceTime);

          if (q.every(Number.isFinite))
            item.arrows.forEach((object, axis) => {
              const direction = new THREE.Vector3().setComponent(axis, 0.5).applyQuaternion(new THREE.Quaternion(...q));
              arrow(object, origin, direction, item.binding.scale);
            });
        } else if (['motors', 'rotors'].includes(item.field.type)) {
          const rotorPositions = item.run.manifest?.mission?.rotor_positions ?? nominalRotors;
          item.field.signals.forEach((id, index) => {
            const value = sample(item.run, id, sourceTime);
            const origin = new THREE.Vector3(...(rotorPositions[index] as [number, number, number]))
              .applyQuaternion(primaryQuaternion)
              .add(primaryPosition);
            // Motor effort is dimensionless and actual rotor speed remains rad/s: these are visual scales, not inferred thrust.
            const magnitude = item.field.type === 'rotors' ? value / 1000 : value;
            arrow(
              item.arrows[index],
              origin,
              new THREE.Vector3(0, 0, magnitude).applyQuaternion(primaryQuaternion),
              item.binding.scale * 0.4,
            );
          });
        } else if (
          item.field.type === 'thrust' ||
          (item.field.type === 'scalar' && /^(thrust|motor\.|rotor\.)/.test(item.field.id))
        ) {
          const value = sample(item.run, item.field.signals[0], sourceTime);
          arrow(
            item.arrows[0],
            primaryPosition,
            new THREE.Vector3(0, 0, value).applyQuaternion(primaryQuaternion),
            item.binding.scale * 0.15,
          );
        } else if (item.field.type === 'scalar' && /^(velocity\.|bodyRate\.)/.test(item.field.id)) {
          const component = Number(item.field.id.split('.').at(-1));
          const value = sample(item.run, item.field.signals[0], sourceTime);
          const direction = new THREE.Vector3().setComponent(component, value);

          if (item.field.frame === 'FLU' || item.field.id.startsWith('bodyRate.'))
            direction.applyQuaternion(orientation);
          arrow(item.arrows[0], origin, direction, item.binding.scale);
        }
      }
      if (followedPose?.root.visible) {
        // Move the camera by the target's displacement, preserving the user's orbit angle and zoom distance.
        // Invalid/out-of-coverage positions hide the root above, so the last valid camera position is retained.
        camera.position.add(followDisplacement.subVectors(followedPose.root.position, controls.target));
        controls.target.copy(followedPose.root.position);
      }
      controls.update();
      renderedCamera.copy(camera);
      if (vehicle && currentFollowOrientation) {
        renderedCamera.position.applyQuaternion(lastQuaternion);
        renderedCamera.up.copy(camera.up).applyQuaternion(lastQuaternion);
        renderedCamera.lookAt(new THREE.Vector3());
      }
      // Ease only explicit camera commands after every pose and follow transform has been updated.
      transition.apply(renderedCamera, performance.now(), reducedMotion ? 0 : undefined);
      if (!lost) renderer.render(scene, renderedCamera);
      frame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cameras.set(tab.id, {
        position: camera.position.clone(),
        target: controls.target.clone(),
        extent,
        mode: currentMode,
        follow: currentFollowOrientation,
        followPose: currentFollowPose,
        quaternion: lastQuaternion.clone(),
        rendered: renderedCamera.clone(),
        transition,
      });
      cancelAnimationFrame(frame);
      resize.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      disposeScene(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      controlsApi.current = null;
    };
  }, [tab.id, tab.bindings, tab.bodyAxes, tab.worldAxes, fields, runs, prepared, vehicle]);

  const pose = tab.bindings.find((binding) => {
    const field = findField(fields, binding.runId, binding.fieldId);
    return binding.visible && (binding.lane === 'vehicle' || (field && spatialLayers(binding, field).pose));
  });
  const poseField = pose ? findField(fields, pose.runId, pose.fieldId) : undefined;
  const q =
    pose && poseField
      ? bindingAttitude(pose, poseField, fields, runs, playback.offsets, playback.effectiveTime)
      : ([NaN, NaN, NaN, NaN] as Quat);
  const angles = toRpy(q).map((value) => (tab.angles === 'degrees' ? (value * 180) / Math.PI : value));

  return (
    <div className="scene-view" data-testid={`${tab.type}-view`}>
      <div ref={host} className="scene-canvas" />
      <div className="scene-toolbar" role="group" aria-label="3D view controls">
        <span>World ENU · Body FLU</span>
        <button
          onClick={() => {
            controlsApi.current?.fit();
            onCameraMode('orbit');
          }}
        >
          Fit
        </button>
        <button
          aria-pressed={tab.camera === 'orbit'}
          onClick={() => {
            controlsApi.current?.mode('orbit');
            onCameraMode('orbit');
          }}
        >
          Orbit
        </button>
        <button
          aria-pressed={tab.camera === 'top'}
          onClick={() => {
            controlsApi.current?.mode('top');
            onCameraMode('top');
          }}
        >
          Top
        </button>
        <button
          aria-pressed={tab.camera === 'side'}
          onClick={() => {
            controlsApi.current?.mode('side');
            onCameraMode('side');
          }}
        >
          Side
        </button>
        {!vehicle && (
          <>
            <button
              aria-pressed={tab.camera === 'follow'}
              disabled={!followPoses.length}
              onClick={() => {
                // Reuse the tab's selected pose when available; otherwise start with the first visible anchor.
                const target = selectedFollowPose ?? followPoses[0];

                if (target) onFollowPose(target.id);
              }}
            >
              Follow
            </button>
            {tab.camera === 'follow' && (
              <FollowPoseMenu tab={tab} poses={followPoses} runs={runs} onSelect={onFollowPose} />
            )}
          </>
        )}
      </div>
      {!vehicle && (
        <div className="scene-legend">
          {tab.bindings
            .filter((binding) => binding.visible)
            .map((binding) => (
              <span key={binding.id}>
                <i style={{ background: binding.color }} />
                {binding.label}
              </span>
            ))}
        </div>
      )}
      <div className="scene-key">
        E / X <i className="east" /> N / Y <i className="north" /> U / Z <i className="up" />
        {!vehicle && <span>Grid {gridSpacing} m</span>}
      </div>
      {failure && (
        <div className="webgl-fallback" role="status">
          {failure}
        </div>
      )}
      {vehicle && (
        <div className="vehicle-readouts">
          <div className="readout">
            <strong>Orientation {tab.angles === 'degrees' ? '(°)' : '(rad)'}</strong>
            <span>
              Roll <b>{Number.isFinite(angles[0]) ? angles[0].toFixed(2) : '—'}</b>
            </span>
            <span>
              Pitch <b>{Number.isFinite(angles[1]) ? angles[1].toFixed(2) : '—'}</b>
            </span>
            <span>
              Yaw <b>{Number.isFinite(angles[2]) ? angles[2].toFixed(2) : '—'}</b>
            </span>
            <small>
              {pose && poseField
                ? fieldValue(
                    poseField,
                    runs.find((run) => run.id === pose.runId),
                    playback.effectiveTime + (playback.offsets.get(pose.runId) ?? NaN),
                    tab.angles === 'degrees',
                  )
                : 'No vehicle selected'}
            </small>
            <small>
              {!q.every(Number.isFinite)
                ? 'Orientation unavailable'
                : tab.followOrientation
                  ? 'Camera follows body orientation'
                  : 'World-fixed camera'}
            </small>
          </div>
          {tab.bindings
            .filter((binding) => binding.visible && binding.lane === 'overlays')
            .map((binding) => {
              const field = findField(fields, binding.runId, binding.fieldId);
              const run = runs.find((item) => item.id === binding.runId);
              const time = playback.effectiveTime + (playback.offsets.get(binding.runId) ?? NaN);

              return (
                field && (
                  <div className="readout" key={binding.id} style={{ borderLeftColor: binding.color }}>
                    <strong>{binding.label}</strong>
                    {field.type === 'motors' || field.type === 'rotors' ? (
                      field.signals.map((id, index) => {
                        const value = run ? sample(run, id, time) : NaN;

                        return (
                          <span key={id}>
                            Rotor {index + 1}
                            <b>
                              {Number.isFinite(value) ? value.toFixed(3) : '—'} {field.unit}
                            </b>
                            {field.type === 'motors' && (
                              <progress max={1} value={Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0} />
                            )}
                          </span>
                        );
                      })
                    ) : (
                      <span className="mono">{fieldValue(field, run, time, tab.angles === 'degrees')}</span>
                    )}
                    <small>
                      {field.type === 'motors'
                        ? 'Command effort · not measured thrust'
                        : field.type === 'rotors'
                          ? 'Actual angular speed'
                          : field.type === 'thrust'
                            ? 'Collective command · N'
                            : field.frame}
                    </small>
                  </div>
                )
              );
            })}
        </div>
      )}
      {!tab.bindings.some((binding) => binding.visible) && (
        <div className="empty-view">Drop fields into the configuration dock.</div>
      )}
    </div>
  );
}
