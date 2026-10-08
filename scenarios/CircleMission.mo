within Rdd2Scenarios;

model CircleMission
  "Take off to 2 m, fly five approximate 3 m-radius circles, and land using mocap"
  parameter Real radius_m(min = 0.1) = 3.0;
  parameter Integer revolutions(min = 1) = 5;
  parameter Integer pointsPerCircle(min = 8) = 16;
  parameter Real cruiseAltitude_m = 2.0;
  parameter Real cruiseSpeed_m_s(min = 0.1) = 1.0;
  final parameter Integer circlePointCount = revolutions * pointsPerCircle + 1;
  constant Real pi = 2.0 * asin(1.0);

  // The circle center is {0, radius, altitude}, so takeoff and landing stay
  // over the initial position. Repeat the angular samples for all five laps.
  parameter Real circleRoute[circlePointCount, 3] = {{
    radius_m * sin(2.0 * pi * (i - 1) / pointsPerCircle),
    radius_m * (1.0 - cos(2.0 * pi * (i - 1) / pointsPerCircle)),
    cruiseAltitude_m} for i in 1:circlePointCount};

  // Tangent velocities let the existing septic Bezier planner join the
  // circle legs smoothly. Stop at the first/last circle point for vertical
  // takeoff/landing; keep moving through all intermediate points and lap joins.
  parameter Real circleVelocity[circlePointCount, 3] = {{
    if i == 1 or i == circlePointCount then 0.0
      else cruiseSpeed_m_s * cos(2.0 * pi * (i - 1) / pointsPerCircle),
    if i == 1 or i == circlePointCount then 0.0
      else cruiseSpeed_m_s * sin(2.0 * pi * (i - 1) / pointsPerCircle),
    0.0} for i in 1:circlePointCount};

  extends Vehicles.Rdd2.WaypointVehicleSystem(
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
    waypointVelocityEnu = cat(1, zeros(1, 3), circleVelocity, zeros(2, 3)));

  // The standard route durations determine arming/disarming. 110 s leaves
  // time for the default approximately 98.34 s route and the disarm delay.
  annotation(experiment(StartTime = 0.0, StopTime = 110.0, Interval = 0.005));
end CircleMission;
