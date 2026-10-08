"""Versioned viewer signal contract and inferred telemetry annotations."""

from __future__ import annotations

import re


SCHEMA = "rdd2-viewer-v1"


TELEMETRY_PATTERNS = tuple(
    re.compile(pattern)
    for pattern in (
        r"(?:time_s|armed|missionPhase|flightMode|imuSamplePeriod_s|estimatorUpdatePeriod_s|thrust_N|"
        r"navigationError_m|controllerEstimatorFeedbackError_m|referenceTrackingError_m)",
        r"(?:position_m|velocity_m_s|euler_rad|geodetic|motorCommand|gpsPositionNoise_m|gpsVelocityNoise_m_s|"
        r"opticalFlowIntegratedNoise_rad|opticalFlowGyroscopeIntegratedNoise_rad|imuAngularVelocityNoise_rad_s|"
        r"imuSpecificForceNoise_m_s2|imuPreintegratedDeltaAngle_rad|imuPreintegratedDeltaVelocity_m_s|"
        r"imuPreintegratedDeltaPosition_m|imuGyroscopeBias_rad_s|imuAccelerometerBias_m_s2|"
        r"mocapPositionNoise_m|mocapAttitudeNoise_rad)\[\d+\]",
        r"plant\.truth\.(?:quaternionWorldBody|accelerationWorldEnu_m_s2|angularVelocityBodyFlu_rad_s)\[\d+\]",
        r"plant\.motorOmega_rad_s\[\d+\]",
        (
            r"(?:referencePositionWorldEnu_m|referenceVelocityWorldEnu_m_s|avionics\.reference\.(?:position|velocity|"
            r"acceleration|jerk|snap))\[\d+\]"
        ),
        (
            r"(?:referenceYaw_rad|avionics\.reference\.(?:valid|complete|sequence|activeSegment|trajectoryTime|"
            r"totalDuration|yaw|yawRate))"
        ),
        (
            r"(?:estimator\.estimate\.(?:valid|timestamp_s|positionWorldEnu_m|velocityWorldEnu_m_s|"
            r"accelerationWorldEnu_m_s2|quaternionWorldBody|eulerRpy_rad|angularVelocityBodyFlu_rad_s|"
            r"angularVelocityWorldEnu_rad_s))\[\d+\]"
        ),
        r"estimator\.estimate\.(?:valid|timestamp_s)",
        r"estimator\.estimate\.rotationWorldBody\[\d+,\d+\]",
        r"estimator\.navigationCovarianceLocal\[\d+,\d+\]",
        (
            r"estimator\.(?:gps\.(?:positionCovarianceWorld_m2|velocityCovarianceWorld_m2_s2)|"
            r"opticalFlow\.(?:integratedLineOfSightCovariance_rad2|integratedGyroscopeCovariance_rad2)|"
            r"mocap\.(?:positionCovarianceWorld_m2|attitudeCovarianceBody_rad2))\[\d+,\d+\]"
        ),
        r"estimator\.(?:gps\.(?:fresh|timestamp_s)|opticalFlow\.(?:fresh|timestamp_s)|mocap\.(?:fresh|timestamp_s))",
        (
            r"estimator\.status\.(?:initialized|predictionAccepted|gpsPositionCorrectionAccepted|"
            r"gpsVelocityCorrectionAccepted|opticalFlowCorrectionAccepted|mocapCorrectionAccepted|anchorSource|"
            r"correctionSource|normalizedInnovationSquared|innovationGateRejected|consecutiveRejectedCorrections|"
            r"covarianceReinitialized)"
        ),
        (
            r"(?:imuAngularVelocityNoiseVariance_rad2_s2|imuSpecificForceNoiseVariance_m2_s4|"
            r"imuGyroscopeBiasIncrementVariance_rad2_s2|imuAccelerometerBiasIncrementVariance_m2_s4)\[\d+\]"
        ),
        (
            r"(?:imuPreintegrationTime_s|opticalFlowGroundDistanceNoise_m|opticalFlowIdealGroundDistance_m|"
            r"opticalFlowSurfaceVisible|estimator\.opticalFlow\.groundDistanceVariance_m2)"
        ),
    )
)


def signal_catalog(names: list[str]) -> dict:
    """Describe exported channels with inferred units, frames, and interpolation kinds.

    Args:
        names: Original Modelica source headers, including any array indices.
    Returns:
        Metadata by channel name, excluding time/time_s. Units and frames are inferred labels; values are not
        converted.
    """

    def entry(name):
        """Infer one source channel's metadata from its Modelica name.

        Args:
            name: One source channel name.
        Returns:
            Label, unit, frame, interpolation kind, and original source name for that channel.
        """

        # Check more specific suffixes first: angular rates contain the angular-position suffix, for example.
        if "_rad_s" in name:
            unit = "rad/s"
        elif "_rad" in name:
            unit = "rad"
        elif "_m_s2" in name:
            unit = "m/s2"
        elif "_m_s" in name:
            unit = "m/s"
        elif re.search(r"_m(?:\[|$)", name):
            unit = "m"
        elif name.endswith("_s"):
            unit = "s"
        elif name.endswith("_N"):
            unit = "N"
        else:
            unit = ""

        held = any(
            s in name
            for s in (
                "estimator.",
                "avionics.",
                "reference",
                "motorCommand",
                "missionPhase",
                "flightMode",
                "armed",
                "Noise",
                "Bias",
                "Period",
            )
        )

        if any(s in name for s in ("Enu", "World", "position_m", "velocity_m_s")):
            frame = "ENU"
        elif "Body" in name:
            frame = "FLU"
        else:
            frame = ""

        return {
            "label": name,
            "unit": unit,
            "frame": frame,
            "kind": "held" if held else "continuous",
            "source": name,
        }

    return {name: entry(name) for name in names if name not in ("time", "time_s")}


def selected(name: str) -> bool:
    """Keep the interactive telemetry contract compact, even for full results.

    Args:
        name: Unqualified exported Modelica signal name to test.
    Returns:
        True for a supported telemetry-contract signal; False for time columns and unselected channels.
    Notes:
        Each regular expression must match the whole name, including the expected component/matrix indices.
    """

    if name in ("time", "time_s"):
        return False

    return any(pattern.fullmatch(name) for pattern in TELEMETRY_PATTERNS)
