using System.Text.Json.Serialization;

namespace ProductionWatcher.Models;

public class ProcessStationUi
{
    [JsonPropertyName("station_id")]
    public int StationId { get; set; }

    [JsonPropertyName("station_name")]
    public string StationName { get; set; } = string.Empty;

    [JsonPropertyName("passed_process_count")]
    public int PassedProcessCount { get; set; }

    [JsonPropertyName("failed_process_count")]
    public int FailedProcessCount { get; set; }

    [JsonPropertyName("aborted_process_count")]
    public int AbortedProcessCount { get; set; }

    [JsonPropertyName("process_count")]
    public int ProcessCount { get; set; }

    [JsonPropertyName("yield")]
    public string Yield { get; set; } = string.Empty;

    [JsonPropertyName("current_step")]
    public string CurrentStep { get; set; } = string.Empty;

    [JsonPropertyName("current_process_plan")]
    public string CurrentProcessPlan { get; set; } = string.Empty;

    [JsonPropertyName("product_name")]
    public string ProductName { get; set; } = string.Empty;

    [JsonPropertyName("current_status")]
    public int CurrentStatus { get; set; }

    [JsonPropertyName("current_station_status")]
    public int CurrentStationStatus { get; set; }

    [JsonPropertyName("elapsed_seconds_for_display")]
    public string ElapsedSecondsForDisplay { get; set; } = string.Empty;

    [JsonPropertyName("progress_percent")]
    public double ProgressPercent { get; set; }

    [JsonPropertyName("current_serial_number")]
    public string CurrentSerialNumber { get; set; } = string.Empty;

    [JsonPropertyName("previous_process_plan_result")]
    public string PreviousProcessPlanResult { get; set; } = string.Empty;

    [JsonPropertyName("previous_process_plan_symptom_label")]
    public string PreviousProcessPlanSymptomLabel { get; set; } = string.Empty;

    [JsonPropertyName("stationsLocked")]
    public bool StationsLocked { get; set; }

    [JsonPropertyName("server_ip")]
    public string ServerIp { get; set; } = string.Empty;

    [JsonPropertyName("status_label")]
    public string StatusLabel => ResolveDisplayStatus().label;

    [JsonPropertyName("status_css_class")]
    public string StatusCssClass => ResolveDisplayStatus().cssClass;

    private (string label, string cssClass) ResolveDisplayStatus()
    {
        var effectiveStatus = ResolveEffectiveStatus();

        // Terminal states always win — matches OpenTest UI for Failed/Aborted/Passed at 100%
        if (effectiveStatus == 4) return ("Failed", "status-failed");
        if (effectiveStatus == 5) return ("Aborted", "status-aborted");

        var isActivelyRunning = effectiveStatus == 3
            || (ProgressPercent > 0 && ProgressPercent < 100)
            || (effectiveStatus == 2 && ProgressPercent > 0 && ProgressPercent < 100);

        if (isActivelyRunning)
        {
            return ("Running", "status-running");
        }

        // Completed or idle — previous result reflects the last test outcome (e.g. Failed with serial still shown)
        if (!string.IsNullOrWhiteSpace(PreviousProcessPlanResult))
        {
            return MapResultToStatus(PreviousProcessPlanResult);
        }

        return effectiveStatus switch
        {
            1 => ("Passed", "status-passed"),
            2 => ("Waiting", "status-waiting"),
            3 => ("Running", "status-running"),
            _ => ("Unknown", "status-unknown")
        };
    }

    private int ResolveEffectiveStatus()
    {
        // OpenTest may leave current_status=1 (Passed) while current_station_status or
        // previous_process_plan_result reflects the actual Failed/Aborted state.
        if (CurrentStatus is 4 or 5) return CurrentStatus;
        if (CurrentStationStatus is 4 or 5) return CurrentStationStatus;

        if (!string.IsNullOrWhiteSpace(PreviousProcessPlanResult))
        {
            var previousStatus = PreviousProcessPlanResult.Trim().ToUpperInvariant() switch
            {
                "FAILED" or "FAIL" => 4,
                "ABORTED" or "ABORT" => 5,
                "PASSED" or "PASS" => 1,
                "RUNNING" => 3,
                "WAITING" => 2,
                _ => 0
            };

            var isComplete = ProgressPercent >= 100 || string.IsNullOrWhiteSpace(CurrentStep);
            if (previousStatus is 4 or 5 && isComplete) return previousStatus;
            if (previousStatus is 4 or 5 && CurrentStatus is 0 or 1 or 2) return previousStatus;
        }

        if (CurrentStatus is 3) return 3;
        if (CurrentStationStatus is 3) return 3;
        if (CurrentStatus > 0) return CurrentStatus;
        return CurrentStationStatus;
    }

    private static (string label, string cssClass) MapResultToStatus(string result)
    {
        return result.Trim().ToUpperInvariant() switch
        {
            "PASSED" or "PASS" => ("Passed", "status-passed"),
            "FAILED" or "FAIL" => ("Failed", "status-failed"),
            "ABORTED" or "ABORT" => ("Aborted", "status-aborted"),
            "RUNNING" => ("Running", "status-running"),
            "WAITING" => ("Waiting", "status-waiting"),
            _ => (result.Trim(), "status-unknown")
        };
    }
}

public class DashboardStationsResponse
{
    [JsonPropertyName("stations")]
    public List<ProcessStationUi> Stations { get; set; } = [];

    [JsonPropertyName("errors")]
    public List<DashboardServerError> Errors { get; set; } = [];
}

public class DashboardServerError
{
    [JsonPropertyName("server_ip")]
    public string ServerIp { get; set; } = string.Empty;

    [JsonPropertyName("error")]
    public string Error { get; set; } = string.Empty;
}
