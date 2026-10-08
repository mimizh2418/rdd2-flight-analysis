within Rdd2Scenarios;

model QualificationMission
  "Take off, fly the original qualification box, and land using mocap navigation"
  parameter Real cruiseAltitude_m = 2.0;
  parameter Real boxSide_m = 4.0;

  extends Vehicles.Rdd2.WaypointVehicleSystem(
    maxWaypoints = 8,
    waypointCount = 8,
    useGlobalWaypoints = false,
    navigationSource = 3,
    fuseMocap = true,
    estimatorInitialPositionWorldEnu_m = {0.08, -0.06, 0.04},
    // Reproduce the qualification route explicitly, with the standard planner,
    // guidance, rate control, sensor noise, and mocap transport delay unchanged.
    localRoute = [
      0.0,       0.0,       0.0;
      0.0,       0.0,       cruiseAltitude_m;
      boxSide_m, 0.0,       cruiseAltitude_m;
      boxSide_m, boxSide_m, cruiseAltitude_m;
      0.0,       boxSide_m, cruiseAltitude_m;
      0.0,       0.0,       cruiseAltitude_m;
      0.0,       0.0,       0.3;
      0.0,       0.0,       0.1]);

  annotation(experiment(StartTime = 0.0, StopTime = 45.0, Interval = 0.005));
end QualificationMission;
