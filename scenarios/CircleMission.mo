within Rdd2Scenarios;

model CircleMission
  "Gentle vertical flight and two exact Dubins circles at 2 m/s using mocap"
  parameter Real radius_m(min = 0.1) = 3.0;
  parameter Integer revolutions(min = 1) = 2;
  parameter Integer pointsPerCircle(min = 8) = 16
    "Display samples per lap; does not set the flown arc or its timing";
  parameter Real cruiseAltitude_m = 2.0;
  parameter Real cruiseSpeed_m_s(unit = "m/s", min = 0.1) = 2.0;
  parameter Real takeoffDuration_s(unit = "s", min = 0.1) = 3.0;
  parameter Real descentDuration_s(unit = "s", min = 0.1) = 3.0;
  parameter Real touchdownDuration_s(unit = "s", min = 0.1) = 1.0;
  parameter Real speedRampDuration_s(unit = "s", min = 0.1) = 2.0;
  final parameter Integer circlePointCount = revolutions * pointsPerCircle + 1;
  constant Real pi = 2.0 * asin(1.0);

  // Specify the full looping arc explicitly: a shortest-path search between
  // identical start/end poses would not enforce the requested revolutions.
  final parameter Planning.Dubins.Path circlePath = Planning.Dubins.Path(
    startPosition = {0.0, 0.0},
    startHeading = 0.0,
    goalPosition = {0.0, 0.0},
    goalHeading = 2.0 * pi * revolutions,
    turnRadius = radius_m,
    pathType = Planning.Dubins.PathType.LSL,
    normalizedSegmentLength = {2.0 * pi * revolutions, 0.0, 0.0},
    length = 2.0 * pi * radius_m * revolutions,
    feasible = true);
  final parameter Real circleDuration_s(unit = "s") =
    circlePath.length / cruiseSpeed_m_s + speedRampDuration_s;
  parameter Real verticalRoute[4, 3] = [
    0.0, 0.0, 0.0;
    0.0, 0.0, cruiseAltitude_m;
    0.0, 0.0, 0.3;
    0.0, 0.0, 0.1];

  // Keep waypoint samples for route display; the mission source evaluates
  // the Dubins geometry directly and supplies its time derivatives.
  parameter Real circleRoute[circlePointCount, 3] = {{
    radius_m * sin(2.0 * pi * (i - 1) / pointsPerCircle),
    radius_m * (1.0 - cos(2.0 * pi * (i - 1) / pointsPerCircle)),
    cruiseAltitude_m}
    for i in 1:circlePointCount};

  extends Vehicles.Rdd2.WaypointVehicleSystem(
    redeclare block ControllerModel = Rdd2Scenarios.CircleMission.DubinsCircleAvionics,
    avionics(
      circlePath = circlePath,
      verticalRoute = verticalRoute,
      verticalDuration_s = {takeoffDuration_s, descentDuration_s, touchdownDuration_s},
      cruiseSpeed_m_s = cruiseSpeed_m_s,
      speedRampDuration_s = speedRampDuration_s),
    maxWaypoints = circlePointCount + 3,
    waypointCount = circlePointCount + 3,
    useGlobalWaypoints = false,
    navigationSource = 3,
    fuseMocap = true,
    estimatorInitialPositionWorldEnu_m = {0.08, -0.06, 0.04},
    nominalSpeed = cruiseSpeed_m_s,
    localRoute = cat(1,
      [0.0, 0.0, 0.0],
      circleRoute,
      [0.0, 0.0, 0.3; 0.0, 0.0, 0.1]),
    trajectoryDuration = takeoffDuration_s + circleDuration_s
      + descentDuration_s + touchdownDuration_s);

  // Keep the trajectory source and controller wiring local to this mission.
  block DubinsCircleTrajectory
    "Dubins circle with smooth speed ramps and independently timed vertical flight"
    parameter Planning.Dubins.Path circlePath;
    parameter Real verticalRoute[4, 3]
      "Ground, cruise altitude, landing approach, and touchdown";
    parameter Real verticalDuration_s[3](each unit = "s") = {3.0, 3.0, 1.0};
    parameter Real cruiseSpeed_m_s(unit = "m/s", min = 0.1) = 2.0;
    parameter Real speedRampDuration_s(unit = "s", min = 0.1) = 2.0;
    constant Real inwardYawOffset_rad = asin(1.0)
      "Quarter-turn left from the tangent toward the circle center";
    final parameter Real circleDuration_s(unit = "s") =
      circlePath.length / cruiseSpeed_m_s + speedRampDuration_s;
    final parameter Real totalDuration_s(unit = "s") =
      sum(verticalDuration_s) + circleDuration_s;

    input Real elapsedTime_s(unit = "s");
    output Planning.Bezier.MultirotorTrajectory trajectory;
    output Integer phase "1 takeoff, 2 circles, 3 descent, 4 touchdown";
    output Real circleDistance_m(unit = "m");
    output Real circleSpeed_m_s(unit = "m/s");

  protected
    Planning.Bezier.MultirotorTrajectory verticalTrajectory;
    Planning.Dubins.Pose circlePose;
    Real clampedTime_s(unit = "s");
    Real verticalTime_s(unit = "s");
    Real circleTime_s(unit = "s");
    Real rampFraction;
    Real rampDirection;
    Real rampIntegral;
    Real speedDerivative_m_s2(unit = "m/s2");
    Real speedSecondDerivative_m_s3;
    Real speedThirdDerivative_m_s4;
    Real tangent[2];
    Real secondSpatialDerivative[2];
    Real thirdSpatialDerivative[2];
    Real fourthSpatialDerivative[2];
    Real takeoffYawControlPoint[1, 8];
    Real takeoffYawTime_s(unit = "s");
    Real takeoffYaw[1];
    Real takeoffYawRate[1];
    Real takeoffYawAcceleration[1];
    Boolean inCircle;
    Boolean holding;

  equation
    assert(circlePath.feasible and circlePath.length > 0.0
        and circlePath.turnRadius > 0.0,
      "The circle needs a feasible positive-length Dubins arc");
    assert(circlePath.pathType == Planning.Dubins.PathType.LSL
        and circlePath.normalizedSegmentLength[1] > 0.0
        and circlePath.normalizedSegmentLength[2] == 0.0
        and circlePath.normalizedSegmentLength[3] == 0.0,
      "Circle references require one left-turn Dubins arc");
    assert(circlePath.length >= cruiseSpeed_m_s * speedRampDuration_s,
      "Circle length must accommodate both speed ramps at the requested cruise speed");
    for i in 1:3 loop
      assert(verticalDuration_s[i] > 0.0, "Vertical segment durations must be positive");
    end for;

    clampedTime_s = min(max(elapsedTime_s, 0.0), totalDuration_s);
    holding = elapsedTime_s <= 0.0 or elapsedTime_s >= totalDuration_s;
    circleTime_s = min(max(clampedTime_s - verticalDuration_s[1], 0.0),
      circleDuration_s);
    inCircle = clampedTime_s >= verticalDuration_s[1]
      and clampedTime_s < verticalDuration_s[1] + circleDuration_s;
    phase = if clampedTime_s < verticalDuration_s[1] then 1
      elseif inCircle then 2
      elseif clampedTime_s < verticalDuration_s[1] + circleDuration_s
        + verticalDuration_s[2] then 3 else 4;

    // Freeze the independently timed vertical Bezier trajectory during circles.
    verticalTime_s = if clampedTime_s < verticalDuration_s[1] then clampedTime_s
      elseif inCircle then verticalDuration_s[1]
      else clampedTime_s - circleDuration_s;
    verticalTrajectory = Planning.Bezier.waypointTrajectory(
      verticalRoute, zeros(4, 3), zeros(4), verticalDuration_s, verticalTime_s);

    // Septic yaw makes yaw rate and acceleration vanish at the takeoff joins.
    takeoffYawTime_s = min(clampedTime_s, verticalDuration_s[1]);
    takeoffYawControlPoint = Planning.Bezier.septicControlPoints(
      [circlePath.startHeading, 0.0, 0.0, 0.0],
      [circlePath.startHeading + inwardYawOffset_rad, 0.0, 0.0, 0.0],
      verticalDuration_s[1]);
    takeoffYaw = Planning.Bezier.evaluate(
      takeoffYawControlPoint, verticalDuration_s[1], takeoffYawTime_s);
    takeoffYawRate = Planning.Bezier.evaluateDerivative(
      takeoffYawControlPoint, verticalDuration_s[1], takeoffYawTime_s, 1);
    takeoffYawAcceleration = Planning.Bezier.evaluateDerivative(
      takeoffYawControlPoint, verticalDuration_s[1], takeoffYawTime_s, 2);

    // Septic smoothstep speed: zero first/second/third speed derivatives at
    // each ramp boundary. Its integral gives exact traveled arc length.
    rampFraction = if circleTime_s < speedRampDuration_s then
        circleTime_s / speedRampDuration_s
      elseif circleTime_s > circleDuration_s - speedRampDuration_s then
        (circleDuration_s - circleTime_s) / speedRampDuration_s
      else 1.0;
    rampDirection = if circleTime_s < speedRampDuration_s then 1.0
      elseif circleTime_s > circleDuration_s - speedRampDuration_s then -1.0
      else 0.0;
    rampIntegral = 7.0 * rampFraction^5 - 14.0 * rampFraction^6
      + 10.0 * rampFraction^7 - 2.5 * rampFraction^8;
    circleDistance_m = if circleTime_s < speedRampDuration_s then
        cruiseSpeed_m_s * speedRampDuration_s * rampIntegral
      elseif circleTime_s > circleDuration_s - speedRampDuration_s then
        circlePath.length - cruiseSpeed_m_s * speedRampDuration_s * rampIntegral
      else cruiseSpeed_m_s * (circleTime_s - 0.5 * speedRampDuration_s);
    circleSpeed_m_s = cruiseSpeed_m_s * (35.0 * rampFraction^4
      - 84.0 * rampFraction^5 + 70.0 * rampFraction^6 - 20.0 * rampFraction^7);
    speedDerivative_m_s2 = rampDirection * cruiseSpeed_m_s / speedRampDuration_s
      * (140.0 * rampFraction^3 - 420.0 * rampFraction^4
        + 420.0 * rampFraction^5 - 140.0 * rampFraction^6);
    speedSecondDerivative_m_s3 = cruiseSpeed_m_s / speedRampDuration_s^2
      * (420.0 * rampFraction^2 - 1680.0 * rampFraction^3
        + 2100.0 * rampFraction^4 - 840.0 * rampFraction^5);
    speedThirdDerivative_m_s4 = rampDirection * cruiseSpeed_m_s / speedRampDuration_s^3
      * (840.0 * rampFraction - 5040.0 * rampFraction^2
        + 8400.0 * rampFraction^3 - 4200.0 * rampFraction^4);

    // This path contains one left-turn arc. Evaluate that Dubins primitive
    // directly, retaining every revolution rather than wrapping its angle.
    circlePose = Planning.Dubins.advance(circlePath.startPosition,
      circlePath.startHeading, Planning.Dubins.SegmentType.left,
      circleDistance_m / circlePath.turnRadius, circlePath.turnRadius);
    tangent = {cos(circlePose.heading), sin(circlePose.heading)};
    secondSpatialDerivative = {-sin(circlePose.heading), cos(circlePose.heading)}
      / circlePath.turnRadius;
    thirdSpatialDerivative = -tangent / circlePath.turnRadius^2;
    fourthSpatialDerivative = -secondSpatialDerivative / circlePath.turnRadius^2;
    trajectory.position = if inCircle then
        {circlePose.position[1], circlePose.position[2], verticalRoute[2, 3]}
      else verticalTrajectory.position;
    trajectory.velocity = if holding then zeros(3)
      elseif inCircle then cat(1,
        circleSpeed_m_s * tangent, {0.0})
      else verticalTrajectory.velocity;
    trajectory.acceleration = if holding then zeros(3)
      elseif inCircle then cat(1,
        circleSpeed_m_s^2 * secondSpatialDerivative
          + speedDerivative_m_s2 * tangent, {0.0})
      else verticalTrajectory.acceleration;
    trajectory.jerk = if holding then zeros(3)
      elseif inCircle then cat(1,
        circleSpeed_m_s^3 * thirdSpatialDerivative
          + 3.0 * circleSpeed_m_s * speedDerivative_m_s2 * secondSpatialDerivative
          + speedSecondDerivative_m_s3 * tangent, {0.0})
      else verticalTrajectory.jerk;
    trajectory.snap = if holding then zeros(3)
      elseif inCircle then cat(1,
        circleSpeed_m_s^4 * fourthSpatialDerivative
          + 6.0 * circleSpeed_m_s^2 * speedDerivative_m_s2 * thirdSpatialDerivative
          + (3.0 * speedDerivative_m_s2^2
            + 4.0 * circleSpeed_m_s * speedSecondDerivative_m_s3) * secondSpatialDerivative
          + speedThirdDerivative_m_s4 * tangent, {0.0})
      else verticalTrajectory.snap;
    // Turn smoothly inward during takeoff, then face the left arc's center.
    // Keep the accumulated turns through landing to avoid resets at lap joins.
    trajectory.yaw = takeoffYaw[1] + circleDistance_m / circlePath.turnRadius;
    trajectory.yawRate = if holding then 0.0
      elseif inCircle then circleSpeed_m_s / circlePath.turnRadius
      else takeoffYawRate[1];
    trajectory.yawAcceleration = if holding then 0.0
      elseif inCircle then speedDerivative_m_s2 / circlePath.turnRadius
      else takeoffYawAcceleration[1];
  end DubinsCircleTrajectory;

  block DubinsCircleAvionics
    "Mission-local Dubins reference source feeding the unchanged RDD2 controller"
    extends Vehicles.Rdd2.PartialController;
    parameter Planning.Dubins.Path circlePath;
    parameter Real verticalRoute[4, 3];
    parameter Real verticalDuration_s[3] = {3.0, 3.0, 1.0};
    parameter Real cruiseSpeed_m_s = 2.0;
    parameter Real speedRampDuration_s = 2.0;

  protected
    Rdd2Scenarios.CircleMission.DubinsCircleTrajectory missionTrajectory(
      circlePath = circlePath,
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
  end DubinsCircleAvionics;

  // The approximately 27.85 s route starts at 1 s and disarms at 31.85 s.
  // Round the horizon to 40 s, at least 5 s after scheduled disarm.
  annotation(experiment(StartTime = 0.0, StopTime = 40.0, Interval = 0.005));
end CircleMission;
