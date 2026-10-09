within Rdd2Scenarios;

model FigureEightMission
  "Bezier approximation of a Lissajous figure-eight with tangent yaw"
  parameter Real longitudinalAmplitude_m(unit = "m", min = 0.1) = 6.0;
  parameter Real lateralAmplitude_m(unit = "m", min = 0.1) = 3.0;
  parameter Real cruiseAltitude_m(unit = "m") = 2.0;
  parameter Real cruiseSpeed_m_s(unit = "m/s", min = 0.1) = 8.25
    "Peak horizontal speed at a center crossing during constant phase rate";
  parameter Real takeoffDuration_s(unit = "s", min = 0.1) = 3.0;
  parameter Real descentDuration_s(unit = "s", min = 0.1) = 3.0;
  parameter Real touchdownDuration_s(unit = "s", min = 0.1) = 1.0;
  parameter Real speedRampDuration_s(unit = "s", min = 0.1) = 2.0;
  parameter Integer pointsPerLobe(min = 8) = 32 "Lissajous samples for display";
  constant Real pi = 2.0 * asin(1.0);
  final parameter Integer figurePointCount = 2 * pointsPerLobe + 1;
  final parameter Real horizontalDuration_s(unit = "s") =
    2.0 * pi * sqrt(longitudinalAmplitude_m^2 + 4.0 * lateralAmplitude_m^2)
      / cruiseSpeed_m_s + speedRampDuration_s;
  parameter Real verticalRoute[4, 3] = [
    0.0, 0.0, 0.0;
    0.0, 0.0, cruiseAltitude_m;
    0.0, 0.0, 0.3;
    0.0, 0.0, 0.1];
  parameter Real figureRoute[figurePointCount, 3] = {{
    longitudinalAmplitude_m * sin(2.0 * pi * (i - 1) / (figurePointCount - 1)),
    lateralAmplitude_m * sin(4.0 * pi * (i - 1) / (figurePointCount - 1)),
    cruiseAltitude_m} for i in 1:figurePointCount};

  extends Vehicles.Rdd2.WaypointVehicleSystem(
    redeclare block ControllerModel = Rdd2Scenarios.FigureEightMission.FigureEightAvionics,
    avionics(
      longitudinalAmplitude_m = longitudinalAmplitude_m,
      lateralAmplitude_m = lateralAmplitude_m,
      verticalRoute = verticalRoute,
      verticalDuration_s = {takeoffDuration_s, descentDuration_s, touchdownDuration_s},
      cruiseSpeed_m_s = cruiseSpeed_m_s,
      speedRampDuration_s = speedRampDuration_s),
    maxWaypoints = figurePointCount + 3,
    waypointCount = figurePointCount + 3,
    useGlobalWaypoints = false,
    navigationSource = 3, fuseMocap = true,
    estimatorInitialPositionWorldEnu_m = {0.08, -0.06, 0.04},
    nominalSpeed = cruiseSpeed_m_s,
    localRoute = cat(1, [0.0, 0.0, 0.0], figureRoute,
      [0.0, 0.0, 0.3; 0.0, 0.0, 0.1]),
    trajectoryDuration = takeoffDuration_s + horizontalDuration_s
      + descentDuration_s + touchdownDuration_s);

  function figureControlPoints
    "Fit nonic segments to Lissajous position and phase derivatives through snap"
    input Real longitudinalAmplitude_m;
    input Real lateralAmplitude_m;
    input Integer segmentCount;
    output Real controlPoint[segmentCount, 2, 10];
  protected
    Real angle;
    Real segmentAngle;
    Real startDerivative[2, 5];
    Real endDerivative[2, 5];
    Real point[2, 10];
  algorithm
    segmentAngle := 4.0 * asin(1.0) / segmentCount;
    for i in 1:segmentCount loop
      angle := (i - 1) * segmentAngle;
      startDerivative := [
        longitudinalAmplitude_m * sin(angle), longitudinalAmplitude_m * cos(angle),
          -longitudinalAmplitude_m * sin(angle), -longitudinalAmplitude_m * cos(angle),
          longitudinalAmplitude_m * sin(angle);
        lateralAmplitude_m * sin(2.0 * angle), 2.0 * lateralAmplitude_m * cos(2.0 * angle),
          -4.0 * lateralAmplitude_m * sin(2.0 * angle), -8.0 * lateralAmplitude_m * cos(2.0 * angle),
          16.0 * lateralAmplitude_m * sin(2.0 * angle)];
      angle := i * segmentAngle;
      endDerivative := [
        longitudinalAmplitude_m * sin(angle), longitudinalAmplitude_m * cos(angle),
          -longitudinalAmplitude_m * sin(angle), -longitudinalAmplitude_m * cos(angle),
          longitudinalAmplitude_m * sin(angle);
        lateralAmplitude_m * sin(2.0 * angle), 2.0 * lateralAmplitude_m * cos(2.0 * angle),
          -4.0 * lateralAmplitude_m * sin(2.0 * angle), -8.0 * lateralAmplitude_m * cos(2.0 * angle),
          16.0 * lateralAmplitude_m * sin(2.0 * angle)];
      // Endpoint finite differences set all ten degree-nine control points.
      point[:, 1] := startDerivative[:, 1];
      point[:, 2] := point[:, 1] + segmentAngle * startDerivative[:, 2] / 9.0;
      point[:, 3] := segmentAngle^2 * startDerivative[:, 3] / 72.0
        + 2.0 * point[:, 2] - point[:, 1];
      point[:, 4] := segmentAngle^3 * startDerivative[:, 4] / 504.0
        + 3.0 * point[:, 3] - 3.0 * point[:, 2] + point[:, 1];
      point[:, 5] := segmentAngle^4 * startDerivative[:, 5] / 3024.0
        + 4.0 * point[:, 4] - 6.0 * point[:, 3] + 4.0 * point[:, 2] - point[:, 1];
      point[:, 10] := endDerivative[:, 1];
      point[:, 9] := point[:, 10] - segmentAngle * endDerivative[:, 2] / 9.0;
      point[:, 8] := segmentAngle^2 * endDerivative[:, 3] / 72.0
        + 2.0 * point[:, 9] - point[:, 10];
      point[:, 7] := -segmentAngle^3 * endDerivative[:, 4] / 504.0
        + 3.0 * point[:, 8] - 3.0 * point[:, 9] + point[:, 10];
      point[:, 6] := segmentAngle^4 * endDerivative[:, 5] / 3024.0
        + 4.0 * point[:, 7] - 6.0 * point[:, 8] + 4.0 * point[:, 9] - point[:, 10];
      controlPoint[i, :, :] := point;
    end for;
  end figureControlPoints;

  block FigureEightTrajectory
    "Piecewise nonic Bezier figure-eight with smooth phase ramps and tangent yaw"
    parameter Real longitudinalAmplitude_m = 6.0;
    parameter Real lateralAmplitude_m = 3.0;
    parameter Real verticalRoute[4, 3];
    parameter Real verticalDuration_s[3] = {3.0, 3.0, 1.0};
    parameter Real cruiseSpeed_m_s = 8.25;
    parameter Real speedRampDuration_s = 2.0;
    constant Real pi = 2.0 * asin(1.0);
    final parameter Real cruisePhaseRate_rad_s = cruiseSpeed_m_s
      / sqrt(longitudinalAmplitude_m^2 + 4.0 * lateralAmplitude_m^2);
    final parameter Real horizontalDuration_s =
      2.0 * pi / cruisePhaseRate_rad_s + speedRampDuration_s;
    final parameter Real totalDuration_s = sum(verticalDuration_s) + horizontalDuration_s;
    final parameter Real initialHeading_rad =
      atan2(2.0 * lateralAmplitude_m, longitudinalAmplitude_m);
    constant Integer segmentCount = 8;
    final parameter Real segmentAngle = 2.0 * pi / segmentCount;
    final parameter Real controlPoint[segmentCount, 2, 10] =
      Rdd2Scenarios.FigureEightMission.figureControlPoints(
        longitudinalAmplitude_m, lateralAmplitude_m, segmentCount);
    final parameter Real rampControlPoint[1, 9] =
      cruisePhaseRate_rad_s * speedRampDuration_s
        * [0.0, 0.0, 0.0, 0.0, 0.0, 0.125, 0.25, 0.375, 0.5];

    input Real elapsedTime_s(unit = "s");
    output Planning.Bezier.MultirotorTrajectory trajectory;
    output Integer phase "1 takeoff, 2 first lobe, 3 second lobe, 4 descent, 5 touchdown";
    output Real phase_rad;
    output Real phaseRate_rad_s;
    output Real speed_m_s;

  protected
    Planning.Bezier.MultirotorTrajectory verticalTrajectory;
    Real p[2];
    Real p1[2];
    Real p2[2];
    Real p3[2];
    Real p4[2];
    Real tangentNormSquared;
    Real tangentCross;
    Real headingPhaseRate;
    Real headingPhaseAcceleration;
    Real curveHeading_rad;
    Real clampedTime_s;
    Real horizontalTime_s;
    Real verticalTime_s;
    Real rampTime_s;
    Real rampDerivative[5, 1];
    Real rampDirection;
    Integer curveSegment;
    Real segmentPhase;
    Real curveDerivative[5, 2];
    Real activeControlPoint[2, 10];
    Real phaseAcceleration_rad_s2;
    Real phaseJerk_rad_s3;
    Real phaseSnap_rad_s4;
    Real takeoffYawControlPoint[1, 8];
    Real takeoffYaw[1];
    Real takeoffYawRate[1];
    Real takeoffYawAcceleration[1];
    Boolean inHorizontal;
    Boolean holding;

  equation
    assert(longitudinalAmplitude_m > 0.0 and lateralAmplitude_m > 0.0
      and cruiseSpeed_m_s > 0.0 and speedRampDuration_s > 0.0,
      "Lissajous extents, speed, and ramp duration must be positive");
    assert(cruisePhaseRate_rad_s * speedRampDuration_s < 2.0 * pi,
      "The Lissajous loop must accommodate both phase-rate ramps");
    for i in 1:3 loop
      assert(verticalDuration_s[i] > 0.0, "Vertical durations must be positive");
    end for;

    clampedTime_s = min(max(elapsedTime_s, 0.0), totalDuration_s);
    holding = elapsedTime_s <= 0.0 or elapsedTime_s >= totalDuration_s;
    horizontalTime_s = min(max(clampedTime_s - verticalDuration_s[1], 0.0), horizontalDuration_s);
    inHorizontal = clampedTime_s >= verticalDuration_s[1]
      and clampedTime_s < verticalDuration_s[1] + horizontalDuration_s;
    verticalTime_s = if clampedTime_s < verticalDuration_s[1] then clampedTime_s
      elseif inHorizontal then verticalDuration_s[1]
      else clampedTime_s - horizontalDuration_s;
    phase = if clampedTime_s < verticalDuration_s[1] then 1
      elseif inHorizontal then (if phase_rad < pi then 2 else 3)
      elseif clampedTime_s < verticalDuration_s[1] + horizontalDuration_s
        + verticalDuration_s[2] then 4 else 5;
    verticalTrajectory = Planning.Bezier.waypointTrajectory(
      verticalRoute, zeros(4, 3), zeros(4), verticalDuration_s, verticalTime_s);

    // Only entry and exit ramp phase rate. The interior crossing remains at
    // full phase rate and is a maximum of physical speed, not a slowdown.
    rampTime_s = min(min(horizontalTime_s,
      horizontalDuration_s - horizontalTime_s), speedRampDuration_s);
    rampDirection = if horizontalTime_s < speedRampDuration_s then 1.0
      elseif horizontalTime_s > horizontalDuration_s - speedRampDuration_s then -1.0 else 0.0;
    rampDerivative[1, :] = Planning.Bezier.evaluate(rampControlPoint, speedRampDuration_s, rampTime_s);
    rampDerivative[2, :] = Planning.Bezier.evaluateDerivative(rampControlPoint, speedRampDuration_s, rampTime_s, 1);
    rampDerivative[3, :] = Planning.Bezier.evaluateDerivative(rampControlPoint, speedRampDuration_s, rampTime_s, 2);
    rampDerivative[4, :] = Planning.Bezier.evaluateDerivative(rampControlPoint, speedRampDuration_s, rampTime_s, 3);
    rampDerivative[5, :] = Planning.Bezier.evaluateDerivative(rampControlPoint, speedRampDuration_s, rampTime_s, 4);
    phase_rad = if horizontalTime_s < speedRampDuration_s then
        rampDerivative[1, 1]
      elseif horizontalTime_s > horizontalDuration_s - speedRampDuration_s then
        2.0 * pi - rampDerivative[1, 1]
      else cruisePhaseRate_rad_s * (horizontalTime_s - 0.5 * speedRampDuration_s);
    phaseRate_rad_s = rampDerivative[2, 1];
    phaseAcceleration_rad_s2 = rampDirection * rampDerivative[3, 1];
    phaseJerk_rad_s3 = rampDerivative[4, 1];
    phaseSnap_rad_s4 = rampDirection * rampDerivative[5, 1];

    // Trigonometry is used only to fit parameter control points. The flown
    // curve and all its spatial derivatives come from the Bezier evaluator.
    curveSegment = min(integer(floor(phase_rad / segmentAngle)) + 1, segmentCount);
    segmentPhase = phase_rad - (curveSegment - 1) * segmentAngle;
    // Rumoca 0.10.2 cannot evaluate a dynamic index into this parameter tensor.
    // Static slices preserve the same selection without changing the planner.
    activeControlPoint = if curveSegment == 1 then controlPoint[1, :, :]
      elseif curveSegment == 2 then controlPoint[2, :, :]
      elseif curveSegment == 3 then controlPoint[3, :, :]
      elseif curveSegment == 4 then controlPoint[4, :, :]
      elseif curveSegment == 5 then controlPoint[5, :, :]
      elseif curveSegment == 6 then controlPoint[6, :, :]
      elseif curveSegment == 7 then controlPoint[7, :, :]
      else controlPoint[8, :, :];
    curveDerivative[1, :] = Planning.Bezier.evaluate(activeControlPoint, segmentAngle, segmentPhase);
    curveDerivative[2, :] = Planning.Bezier.evaluateDerivative(activeControlPoint, segmentAngle, segmentPhase, 1);
    curveDerivative[3, :] = Planning.Bezier.evaluateDerivative(activeControlPoint, segmentAngle, segmentPhase, 2);
    curveDerivative[4, :] = Planning.Bezier.evaluateDerivative(activeControlPoint, segmentAngle, segmentPhase, 3);
    curveDerivative[5, :] = Planning.Bezier.evaluateDerivative(activeControlPoint, segmentAngle, segmentPhase, 4);
    p = curveDerivative[1, :];
    p1 = curveDerivative[2, :];
    p2 = curveDerivative[3, :];
    p3 = curveDerivative[4, :];
    p4 = curveDerivative[5, :];
    trajectory.position = if inHorizontal then {p[1], p[2], verticalRoute[2, 3]} else verticalTrajectory.position;
    trajectory.velocity = if holding then zeros(3)
      elseif inHorizontal then cat(1, p1 * phaseRate_rad_s, {0.0}) else verticalTrajectory.velocity;
    trajectory.acceleration = if holding then zeros(3)
      elseif inHorizontal then cat(1, p2 * phaseRate_rad_s^2 + p1 * phaseAcceleration_rad_s2, {0.0})
      else verticalTrajectory.acceleration;
    trajectory.jerk = if holding then zeros(3)
      elseif inHorizontal then cat(1, p3 * phaseRate_rad_s^3
        + 3.0 * p2 * phaseRate_rad_s * phaseAcceleration_rad_s2 + p1 * phaseJerk_rad_s3, {0.0})
      else verticalTrajectory.jerk;
    trajectory.snap = if holding then zeros(3)
      elseif inHorizontal then cat(1, p4 * phaseRate_rad_s^4
        + 6.0 * p3 * phaseRate_rad_s^2 * phaseAcceleration_rad_s2
        + p2 * (3.0 * phaseAcceleration_rad_s2^2 + 4.0 * phaseRate_rad_s * phaseJerk_rad_s3)
        + p1 * phaseSnap_rad_s4, {0.0}) else verticalTrajectory.snap;

    // Geometric tangent stays nonzero at rest. Select the atan2 branch by
    // tangent signs so rounding at either negative-x crossing cannot add a turn.
    tangentNormSquared = p1 * p1;
    tangentCross = p1[1] * p2[2] - p1[2] * p2[1];
    headingPhaseRate = tangentCross / tangentNormSquared;
    headingPhaseAcceleration = (p1[1] * p3[2] - p1[2] * p3[1]) / tangentNormSquared
      - 2.0 * tangentCross * (p1 * p2) / tangentNormSquared^2;
    curveHeading_rad = atan2(p1[2], p1[1])
      - (if p1[1] < 0.0 and p1[2] >= 0.0 then 2.0 * pi else 0.0);
    speed_m_s = sqrt(trajectory.velocity * trajectory.velocity);

    takeoffYawControlPoint = Planning.Bezier.septicControlPoints(
      [0.0, 0.0, 0.0, 0.0], [initialHeading_rad, 0.0, 0.0, 0.0], verticalDuration_s[1]);
    takeoffYaw = Planning.Bezier.evaluate(takeoffYawControlPoint,
      verticalDuration_s[1], min(clampedTime_s, verticalDuration_s[1]));
    takeoffYawRate = Planning.Bezier.evaluateDerivative(takeoffYawControlPoint,
      verticalDuration_s[1], min(clampedTime_s, verticalDuration_s[1]), 1);
    takeoffYawAcceleration = Planning.Bezier.evaluateDerivative(takeoffYawControlPoint,
      verticalDuration_s[1], min(clampedTime_s, verticalDuration_s[1]), 2);
    trajectory.yaw = if inHorizontal then curveHeading_rad else takeoffYaw[1];
    trajectory.yawRate = if holding then 0.0
      elseif inHorizontal then headingPhaseRate * phaseRate_rad_s else takeoffYawRate[1];
    trajectory.yawAcceleration = if holding then 0.0
      elseif inHorizontal then (headingPhaseAcceleration * phaseRate_rad_s^2
        + headingPhaseRate * phaseAcceleration_rad_s2) else takeoffYawAcceleration[1];
  end FigureEightTrajectory;

  block FigureEightAvionics
    "Mission-local figure-eight reference source feeding the unchanged RDD2 controller"
    extends Vehicles.Rdd2.PartialController;
    parameter Real longitudinalAmplitude_m = 6.0;
    parameter Real lateralAmplitude_m = 3.0;
    parameter Real verticalRoute[4, 3];
    parameter Real verticalDuration_s[3] = {3.0, 3.0, 1.0};
    parameter Real cruiseSpeed_m_s = 8.25;
    parameter Real speedRampDuration_s = 2.0;

  protected
    Rdd2Scenarios.FigureEightMission.FigureEightTrajectory missionTrajectory(
      longitudinalAmplitude_m = longitudinalAmplitude_m,
      lateralAmplitude_m = lateralAmplitude_m,
      verticalRoute = verticalRoute,
      verticalDuration_s = verticalDuration_s,
      cruiseSpeed_m_s = cruiseSpeed_m_s,
      speedRampDuration_s = speedRampDuration_s);
    Vehicles.Rdd2.Controller controller(
      samplePeriod = ratePeriod,
      guidancePeriod = guidancePeriod);
    Vehicles.Rdd2.ManualTrajectorySource manualTask(
      samplePeriod = planningPeriod,
      horizontalSpeed_m_s = manualHorizontalSpeed_m_s,
      climbSpeed_m_s = manualClimbSpeed_m_s,
      descentSpeed_m_s = manualDescentSpeed_m_s,
      headingRate_rad_s = manualHeadingRate_rad_s,
      horizontalLeash_m = manualHorizontalLeash_m,
      verticalLeash_m = manualVerticalLeash_m,
      horizontalSpeedLeash_m_s = manualHorizontalSpeedLeash_m_s,
      verticalSpeedLeash_m_s = manualVerticalSpeedLeash_m_s);
    discrete Real trajectoryTime_s(unit = "s", start = 0.0, fixed = true);
    discrete Integer lastPlanSequence(start = -1, fixed = true);
    Boolean manualEngaged;

  equation
    // Geometry and timing are mission parameters; the existing plan message
    // still starts/resets the clock. Its waypoint rows are display samples.
    missionTrajectory.elapsedTime_s = trajectoryTime_s;
    manualEngaged = mode == 3;
    manualTask.engaged = manualEngaged;
    connect(pilot, manualTask.pilot);
    manualTask.navigation.positionWorldEnu_m = navigation.positionWorldEnu_m;
    manualTask.navigation.velocityWorldEnu_m_s = navigation.velocityWorldEnu_m_s;
    manualTask.navigation.quaternionWorldBody = navigation.quaternionWorldBody;

    reference.valid = manualEngaged or plan.valid;
    reference.complete = not manualEngaged and plan.valid
      and trajectoryTime_s >= missionTrajectory.totalDuration_s;
    reference.sequence = lastPlanSequence;
    reference.activeSegment = missionTrajectory.phase;
    reference.trajectoryTime = trajectoryTime_s;
    reference.totalDuration = missionTrajectory.totalDuration_s;
    reference.position = if manualEngaged then manualTask.positionWorldEnu_m
      else missionTrajectory.trajectory.position;
    reference.velocity = if manualEngaged then manualTask.velocityWorldEnu_m_s
      else missionTrajectory.trajectory.velocity;
    reference.acceleration = if manualEngaged then manualTask.accelerationWorldEnu_m_s2
      else missionTrajectory.trajectory.acceleration;
    reference.jerk = if manualEngaged then zeros(3) else missionTrajectory.trajectory.jerk;
    reference.snap = if manualEngaged then zeros(3) else missionTrajectory.trajectory.snap;
    reference.yaw = if manualEngaged then manualTask.yaw_rad else missionTrajectory.trajectory.yaw;
    reference.yawRate = if manualEngaged then manualTask.headingRateCommand_rad_s
      else missionTrajectory.trajectory.yawRate;
    reference.yawAcceleration = if manualEngaged then 0.0
      else missionTrajectory.trajectory.yawAcceleration;

    connect(navigation, controller.navigation);
    connect(pilot, controller.pilot);
    controller.mode = mode;
    controller.armed = armed;
    controller.reference.positionWorld_m = reference.position;
    controller.reference.velocityWorld_m_s = reference.velocity;
    controller.reference.accelerationWorld_m_s2 = reference.acceleration;
    controller.reference.jerkWorld_m_s3 = reference.jerk;
    controller.reference.snapWorld_m_s4 = reference.snap;
    controller.reference.yaw_rad = reference.yaw;
    controller.reference.yawRate_rad_s = reference.yawRate;
    controller.reference.yawAcceleration_rad_s2 = reference.yawAcceleration;
    motorCommands.motor = controller.motorCommands.motor;
    thrust_N = controller.thrust_N;

  algorithm
    when sample(0.0, planningPeriod) then
      if not plan.valid or plan.sequence <> pre(lastPlanSequence) then
        lastPlanSequence := plan.sequence;
        trajectoryTime_s := 0.0;
      else
        trajectoryTime_s := min(pre(trajectoryTime_s)
          + (if manualEngaged then 0.0 else planningPeriod), missionTrajectory.totalDuration_s);
      end if;
    end when;
  end FigureEightAvionics;

  // Default scheduled disarm is approximately 19.46 s. A round 25 s horizon
  // leaves more than 5 s after disarm, including planner-clock rounding.
  annotation(experiment(StartTime = 0.0, StopTime = 25.0, Interval = 0.005));
end FigureEightMission;
