within Rdd2Scenarios;

model FigureEightMission
  "Dubins figure-eight at 2.5 m/s with a smooth crossing and tangent yaw"
  parameter Real radius_m(unit = "m", min = 0.1) = 3.0;
  parameter Real cruiseAltitude_m(unit = "m") = 2.0;
  parameter Real cruiseSpeed_m_s(unit = "m/s", min = 0.1) = 2.5;
  parameter Real takeoffDuration_s(unit = "s", min = 0.1) = 3.0;
  parameter Real descentDuration_s(unit = "s", min = 0.1) = 3.0;
  parameter Real touchdownDuration_s(unit = "s", min = 0.1) = 1.0;
  parameter Real speedRampDuration_s(unit = "s", min = 0.1) = 2.0;
  parameter Real crossingBlendAngle_rad(unit = "rad", min = 0.4, max = 0.7) = 0.5;
  parameter Integer pointsPerLobe(min = 8) = 16 "Nominal Dubins samples for display";
  constant Real pi = 2.0 * asin(1.0);
  final parameter Integer figurePointCount = 2 * pointsPerLobe + 1;

  // Trim the touching Dubins lobes and bridge their opposite curvatures.
  // At nonzero speed a direct left/right arc join would jump acceleration.
  final parameter Planning.Dubins.Path leftPath = Planning.Dubins.Path(
    startPosition = {0.0, 0.0}, startHeading = 0.0,
    goalPosition = {-radius_m * sin(crossingBlendAngle_rad),
      radius_m * (1.0 - cos(crossingBlendAngle_rad))},
    goalHeading = 2.0 * pi - crossingBlendAngle_rad,
    turnRadius = radius_m, pathType = Planning.Dubins.PathType.LSL,
    normalizedSegmentLength = {2.0 * pi - crossingBlendAngle_rad, 0.0, 0.0},
    length = radius_m * (2.0 * pi - crossingBlendAngle_rad), feasible = true);
  final parameter Planning.Dubins.Path rightPath = Planning.Dubins.Path(
    startPosition = {radius_m * sin(crossingBlendAngle_rad),
      -radius_m * (1.0 - cos(crossingBlendAngle_rad))},
    startHeading = 2.0 * pi - crossingBlendAngle_rad,
    goalPosition = {0.0, 0.0}, goalHeading = 0.0,
    turnRadius = radius_m, pathType = Planning.Dubins.PathType.RSR,
    normalizedSegmentLength = {2.0 * pi - crossingBlendAngle_rad, 0.0, 0.0},
    length = radius_m * (2.0 * pi - crossingBlendAngle_rad), feasible = true);
  final parameter Real arcDuration_s(unit = "s") =
    leftPath.length / cruiseSpeed_m_s + 0.5 * speedRampDuration_s;
  // Slightly shorten the bridge traversal to avoid a cruise-speed dip in
  // the blended reference; the default crossing peaks at about 2.62 m/s.
  final parameter Real crossingDuration_s(unit = "s") =
    0.98 * 2.0 * radius_m * crossingBlendAngle_rad / cruiseSpeed_m_s;
  parameter Real verticalRoute[4, 3] = [
    0.0, 0.0, 0.0;
    0.0, 0.0, cruiseAltitude_m;
    0.0, 0.0, 0.3;
    0.0, 0.0, 0.1];
  parameter Real figureRoute[figurePointCount, 3] = {{
    radius_m * sin(2.0 * pi * (i - 1) / pointsPerLobe),
    (if i <= pointsPerLobe + 1 then 1.0 else -1.0)
      * radius_m * (1.0 - cos(2.0 * pi * (i - 1) / pointsPerLobe)),
    cruiseAltitude_m} for i in 1:figurePointCount};

  extends Vehicles.Rdd2.WaypointVehicleSystem(
    redeclare block ControllerModel = Rdd2Scenarios.FigureEightMission.FigureEightAvionics,
    avionics(
      leftPath = leftPath, rightPath = rightPath,
      verticalRoute = verticalRoute,
      verticalDuration_s = {takeoffDuration_s, descentDuration_s, touchdownDuration_s},
      cruiseSpeed_m_s = cruiseSpeed_m_s,
      speedRampDuration_s = speedRampDuration_s,
      crossingDuration_s = crossingDuration_s),
    maxWaypoints = figurePointCount + 3,
    waypointCount = figurePointCount + 3,
    useGlobalWaypoints = false,
    navigationSource = 3, fuseMocap = true,
    estimatorInitialPositionWorldEnu_m = {0.08, -0.06, 0.04},
    nominalSpeed = cruiseSpeed_m_s,
    localRoute = cat(1, [0.0, 0.0, 0.0], figureRoute,
      [0.0, 0.0, 0.3; 0.0, 0.0, 0.1]),
    trajectoryDuration = takeoffDuration_s + 2.0 * arcDuration_s
      + crossingDuration_s + descentDuration_s + touchdownDuration_s);

  function crossingControlPoints
    "C3 bridge between Dubins arcs, preserving their cruise-speed derivatives"
    input Planning.Dubins.Path leftPath;
    input Planning.Dubins.Path rightPath;
    input Real altitude;
    input Real speed;
    input Real duration;
    output Real controlPoint[3, 8];
  protected
    Real startTangent[2];
    Real endTangent[2];
    Real startAcceleration[2];
    Real endAcceleration[2];
    Real startJerk[2];
    Real endJerk[2];
  algorithm
    startTangent := {cos(leftPath.goalHeading), sin(leftPath.goalHeading)};
    endTangent := {cos(rightPath.startHeading), sin(rightPath.startHeading)};
    startAcceleration := speed^2 / leftPath.turnRadius
      * {-startTangent[2], startTangent[1]};
    endAcceleration := -speed^2 / rightPath.turnRadius
      * {-endTangent[2], endTangent[1]};
    startJerk := -speed^3 / leftPath.turnRadius^2 * startTangent;
    endJerk := -speed^3 / rightPath.turnRadius^2 * endTangent;
    controlPoint := Planning.Bezier.septicControlPoints(
      [leftPath.goalPosition[1], speed * startTangent[1], startAcceleration[1], startJerk[1];
       leftPath.goalPosition[2], speed * startTangent[2], startAcceleration[2], startJerk[2];
       altitude, 0.0, 0.0, 0.0],
      [rightPath.startPosition[1], speed * endTangent[1], endAcceleration[1], endJerk[1];
       rightPath.startPosition[2], speed * endTangent[2], endAcceleration[2], endJerk[2];
       altitude, 0.0, 0.0, 0.0], duration);
  end crossingControlPoints;

  block FigureEightTrajectory
    "Dubins lobes with a nonstopping septic crossing, tangent yaw, and gentle vertical flight"
    parameter Planning.Dubins.Path leftPath;
    parameter Planning.Dubins.Path rightPath;
    parameter Real verticalRoute[4, 3];
    parameter Real verticalDuration_s[3] = {3.0, 3.0, 1.0};
    parameter Real cruiseSpeed_m_s = 2.5;
    parameter Real speedRampDuration_s = 2.0;
    parameter Real crossingDuration_s;
    constant Real pi = 2.0 * asin(1.0);
    final parameter Real arcDuration_s =
      leftPath.length / cruiseSpeed_m_s + 0.5 * speedRampDuration_s;
    final parameter Real horizontalDuration_s = 2.0 * arcDuration_s + crossingDuration_s;
    final parameter Real totalDuration_s = sum(verticalDuration_s) + horizontalDuration_s;

    input Real elapsedTime_s(unit = "s");
    output Planning.Bezier.MultirotorTrajectory trajectory;
    output Integer phase "1 takeoff, 2 left lobe, 3 crossing, 4 right lobe, 5 descent, 6 touchdown";
    output Real arcDistance_m;
    output Real arcSpeed_m_s;

  protected
    Planning.Bezier.MultirotorTrajectory verticalTrajectory;
    Planning.Dubins.Pose arcPose;
    Real crossingControlPoint[3, 8];
    Real crossingPosition[3];
    Real crossingVelocity[3];
    Real crossingAcceleration[3];
    Real crossingJerk[3];
    Real crossingSnap[3];
    Real clampedTime_s;
    Real horizontalTime_s;
    Real arcTime_s;
    Real verticalTime_s;
    Real crossingTime_s;
    Real rampFraction;
    Real rampIntegral;
    Real rampDirection;
    Real speedDerivative;
    Real speedSecondDerivative;
    Real speedThirdDerivative;
    Real curvature;
    Real tangent[2];
    Real secondSpatialDerivative[2];
    Real thirdSpatialDerivative[2];
    Real fourthSpatialDerivative[2];
    Real crossingSpeedSquared;
    Real crossingVelocityAccelerationCross;
    Real crossingVelocityJerkCross;
    Boolean rightLobe;
    Boolean inHorizontal;
    Boolean inCrossing;
    Boolean holding;

  equation
    assert(leftPath.feasible and rightPath.feasible
      and leftPath.pathType == Planning.Dubins.PathType.LSL
      and rightPath.pathType == Planning.Dubins.PathType.RSR,
      "The figure-eight needs left and right Dubins arcs");
    assert(leftPath.length >= 0.5 * cruiseSpeed_m_s * speedRampDuration_s
      and abs(leftPath.length - rightPath.length) < 1.0e-8,
      "Equal-length Dubins lobes must accommodate the entry and exit ramps");
    assert(crossingDuration_s > 0.0 and speedRampDuration_s > 0.0,
      "Crossing and speed-ramp durations must be positive");
    for i in 1:3 loop
      assert(verticalDuration_s[i] > 0.0, "Vertical durations must be positive");
    end for;

    clampedTime_s = min(max(elapsedTime_s, 0.0), totalDuration_s);
    holding = elapsedTime_s <= 0.0 or elapsedTime_s >= totalDuration_s;
    horizontalTime_s = min(max(clampedTime_s - verticalDuration_s[1], 0.0), horizontalDuration_s);
    inHorizontal = clampedTime_s >= verticalDuration_s[1]
      and clampedTime_s < verticalDuration_s[1] + horizontalDuration_s;
    inCrossing = inHorizontal and horizontalTime_s >= arcDuration_s
      and horizontalTime_s < arcDuration_s + crossingDuration_s;
    rightLobe = horizontalTime_s >= arcDuration_s + crossingDuration_s;
    arcTime_s = if rightLobe then
      min(max(horizontalTime_s - arcDuration_s - crossingDuration_s, 0.0), arcDuration_s)
      else min(horizontalTime_s, arcDuration_s);
    crossingTime_s = min(max(horizontalTime_s - arcDuration_s, 0.0), crossingDuration_s);
    verticalTime_s = if clampedTime_s < verticalDuration_s[1] then clampedTime_s
      elseif inHorizontal then verticalDuration_s[1]
      else clampedTime_s - horizontalDuration_s;
    phase = if clampedTime_s < verticalDuration_s[1] then 1
      elseif inCrossing then 3
      elseif inHorizontal then (if rightLobe then 4 else 2)
      elseif clampedTime_s < verticalDuration_s[1] + horizontalDuration_s
        + verticalDuration_s[2] then 5 else 6;
    verticalTrajectory = Planning.Bezier.waypointTrajectory(
      verticalRoute, zeros(4, 3), zeros(4), verticalDuration_s, verticalTime_s);

    // Only entry and exit change speed. Cruise continues through the crossing.
    rampFraction = if not rightLobe then min(arcTime_s / speedRampDuration_s, 1.0)
      else min((arcDuration_s - arcTime_s) / speedRampDuration_s, 1.0);
    rampDirection = if rampFraction < 1.0 then (if rightLobe then -1.0 else 1.0) else 0.0;
    rampIntegral = 7.0 * rampFraction^5 - 14.0 * rampFraction^6
      + 10.0 * rampFraction^7 - 2.5 * rampFraction^8;
    arcDistance_m = if rightLobe then
        (if rampFraction < 1.0 then rightPath.length
          - cruiseSpeed_m_s * speedRampDuration_s * rampIntegral
         else cruiseSpeed_m_s * arcTime_s)
      else (if rampFraction < 1.0 then
        cruiseSpeed_m_s * speedRampDuration_s * rampIntegral
        else cruiseSpeed_m_s * (arcTime_s - 0.5 * speedRampDuration_s));
    arcSpeed_m_s = cruiseSpeed_m_s * (35.0 * rampFraction^4 - 84.0 * rampFraction^5
      + 70.0 * rampFraction^6 - 20.0 * rampFraction^7);
    speedDerivative = rampDirection * cruiseSpeed_m_s / speedRampDuration_s
      * (140.0 * rampFraction^3 - 420.0 * rampFraction^4
        + 420.0 * rampFraction^5 - 140.0 * rampFraction^6);
    speedSecondDerivative = cruiseSpeed_m_s / speedRampDuration_s^2
      * (420.0 * rampFraction^2 - 1680.0 * rampFraction^3
        + 2100.0 * rampFraction^4 - 840.0 * rampFraction^5);
    speedThirdDerivative = rampDirection * cruiseSpeed_m_s / speedRampDuration_s^3
      * (840.0 * rampFraction - 5040.0 * rampFraction^2
        + 8400.0 * rampFraction^3 - 4200.0 * rampFraction^4);
    arcPose = Planning.Dubins.advance(
      if rightLobe then rightPath.startPosition else leftPath.startPosition,
      if rightLobe then rightPath.startHeading else leftPath.startHeading,
      if rightLobe then Planning.Dubins.SegmentType.right else Planning.Dubins.SegmentType.left,
      arcDistance_m / leftPath.turnRadius, leftPath.turnRadius);
    curvature = (if rightLobe then -1.0 else 1.0) / leftPath.turnRadius;
    tangent = {cos(arcPose.heading), sin(arcPose.heading)};
    secondSpatialDerivative = curvature * {-tangent[2], tangent[1]};
    thirdSpatialDerivative = -curvature^2 * tangent;
    fourthSpatialDerivative = -curvature^2 * secondSpatialDerivative;

    crossingControlPoint = Rdd2Scenarios.FigureEightMission.crossingControlPoints(
      leftPath, rightPath, verticalRoute[2, 3], cruiseSpeed_m_s, crossingDuration_s);
    crossingPosition = Planning.Bezier.evaluate(crossingControlPoint, crossingDuration_s, crossingTime_s);
    crossingVelocity = Planning.Bezier.evaluateDerivative(crossingControlPoint, crossingDuration_s, crossingTime_s, 1);
    crossingAcceleration = Planning.Bezier.evaluateDerivative(crossingControlPoint, crossingDuration_s, crossingTime_s, 2);
    crossingJerk = Planning.Bezier.evaluateDerivative(crossingControlPoint, crossingDuration_s, crossingTime_s, 3);
    crossingSnap = Planning.Bezier.evaluateDerivative(crossingControlPoint, crossingDuration_s, crossingTime_s, 4);

    trajectory.position = if inCrossing then crossingPosition
      elseif inHorizontal then {arcPose.position[1], arcPose.position[2], verticalRoute[2, 3]}
      else verticalTrajectory.position;
    trajectory.velocity = if holding then zeros(3)
      elseif inCrossing then crossingVelocity
      elseif inHorizontal then cat(1, arcSpeed_m_s * tangent, {0.0})
      else verticalTrajectory.velocity;
    trajectory.acceleration = if holding then zeros(3)
      elseif inCrossing then crossingAcceleration
      elseif inHorizontal then cat(1,
        arcSpeed_m_s^2 * secondSpatialDerivative + speedDerivative * tangent, {0.0})
      else verticalTrajectory.acceleration;
    trajectory.jerk = if holding then zeros(3)
      elseif inCrossing then crossingJerk
      elseif inHorizontal then cat(1,
        arcSpeed_m_s^3 * thirdSpatialDerivative
          + 3.0 * arcSpeed_m_s * speedDerivative * secondSpatialDerivative
          + speedSecondDerivative * tangent, {0.0})
      else verticalTrajectory.jerk;
    trajectory.snap = if holding then zeros(3)
      elseif inCrossing then crossingSnap
      elseif inHorizontal then cat(1,
        arcSpeed_m_s^4 * fourthSpatialDerivative
          + 6.0 * arcSpeed_m_s^2 * speedDerivative * thirdSpatialDerivative
          + (3.0 * speedDerivative^2 + 4.0 * arcSpeed_m_s * speedSecondDerivative)
            * secondSpatialDerivative + speedThirdDerivative * tangent, {0.0})
      else verticalTrajectory.snap;

    // The bridge keeps forward x velocity, so adding one full turn unwraps
    // atan2 continuously between the left and right Dubins headings.
    crossingSpeedSquared = crossingVelocity[1]^2 + crossingVelocity[2]^2;
    crossingVelocityAccelerationCross = crossingVelocity[1] * crossingAcceleration[2]
      - crossingVelocity[2] * crossingAcceleration[1];
    crossingVelocityJerkCross = crossingVelocity[1] * crossingJerk[2]
      - crossingVelocity[2] * crossingJerk[1];
    trajectory.yaw = if inCrossing then 2.0 * pi
        + atan2(crossingVelocity[2], crossingVelocity[1]) else arcPose.heading;
    trajectory.yawRate = if holding or not inHorizontal then 0.0
      elseif inCrossing then crossingVelocityAccelerationCross / crossingSpeedSquared
      else curvature * arcSpeed_m_s;
    trajectory.yawAcceleration = if holding or not inHorizontal then 0.0
      elseif inCrossing then crossingVelocityJerkCross / crossingSpeedSquared
        - 2.0 * crossingVelocityAccelerationCross
          * (crossingVelocity[1] * crossingAcceleration[1]
            + crossingVelocity[2] * crossingAcceleration[2]) / crossingSpeedSquared^2
      else curvature * speedDerivative;
  end FigureEightTrajectory;

  block FigureEightAvionics
    "Mission-local figure-eight reference source feeding the unchanged RDD2 controller"
    extends Vehicles.Rdd2.PartialController;
    parameter Planning.Dubins.Path leftPath;
    parameter Planning.Dubins.Path rightPath;
    parameter Real verticalRoute[4, 3];
    parameter Real verticalDuration_s[3] = {3.0, 3.0, 1.0};
    parameter Real cruiseSpeed_m_s = 2.5;
    parameter Real speedRampDuration_s = 2.0;
    parameter Real crossingDuration_s;

  protected
    Rdd2Scenarios.FigureEightMission.FigureEightTrajectory missionTrajectory(
      leftPath = leftPath,
      rightPath = rightPath,
      verticalRoute = verticalRoute,
      verticalDuration_s = verticalDuration_s,
      cruiseSpeed_m_s = cruiseSpeed_m_s,
      speedRampDuration_s = speedRampDuration_s,
      crossingDuration_s = crossingDuration_s);
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
    controller.reference.yaw_rad = reference.yaw;
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

  // Default scheduled disarm is approximately 28.06 s. A round 35 s horizon
  // leaves more than 5 s after disarm, including planner-clock rounding.
  annotation(experiment(StartTime = 0.0, StopTime = 35.0, Interval = 0.005));
end FigureEightMission;
