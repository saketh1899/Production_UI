using Microsoft.AspNetCore.Mvc;
using ProductionWatcher.Models;
using ProductionWatcher.Services;

namespace ProductionWatcher.Controllers;

public class DashboardController : Controller
{
    private readonly IOpenTestApiService _openTestApiService;
    private readonly IConfiguration _configuration;
    private readonly ILogger<DashboardController> _logger;

    public DashboardController(
        IOpenTestApiService openTestApiService,
        IConfiguration configuration,
        ILogger<DashboardController> logger)
    {
        _openTestApiService = openTestApiService;
        _configuration = configuration;
        _logger = logger;
    }

    public IActionResult Index()
    {
        var pollIntervalMs = Math.Clamp(_configuration.GetValue("OpenTest:PollIntervalMs", 2000), 500, 60000);
        ViewBag.PollIntervalMs = pollIntervalMs;
        ViewBag.RackCount = Math.Clamp(_configuration.GetValue("RackLayout:RackCount", 6), 1, 24);
        ViewBag.SlotsPerRack = Math.Clamp(_configuration.GetValue("RackLayout:SlotsPerRack", 3), 1, 12);
        ViewBag.ProductName = _configuration.GetValue<string>("Dashboard:ProductName") ?? string.Empty;
        ViewBag.FlagPendingMinutes = Math.Clamp(_configuration.GetValue("Dashboard:FlagPendingDelayMinutes", 5), 0, 120);
        return View();
    }

    [HttpGet]
    public async Task<IActionResult> Stations(string serverIp, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(serverIp))
        {
            return BadRequest(new { error = "At least one server IP address is required." });
        }

        var slots = ParseServerSlots(serverIp);
        if (slots.Count == 0)
        {
            return BadRequest(new { error = "At least one server IP address is required." });
        }

        var response = new DashboardStationsResponse();
        var fetchTasks = slots.Select(slot => FetchStationsForServerAsync(slot, cancellationToken));
        var results = await Task.WhenAll(fetchTasks);

        foreach (var (result, slot) in results.Zip(slots))
        {
            if (result.Error is not null)
            {
                result.Error.ServerIp = slot.Label;
                response.Errors.Add(result.Error);
                continue;
            }

            response.Stations.AddRange(result.Stations!);
        }

        response.Stations = response.Stations
            .OrderBy(s => s.ServerIp)
            .ThenBy(s => s.StationId)
            .ToList();

        if (response.Stations.Count == 0 && response.Errors.Count > 0)
        {
            return StatusCode(502, response);
        }

        return Json(response);
    }

    private static List<ServerSlot> ParseServerSlots(string serverIp)
    {
        var rawAddresses = serverIp
            .Split([',', ';', '\n', '\r'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(address => !string.IsNullOrWhiteSpace(address))
            .ToList();

        var slots = new List<ServerSlot>();
        for (var i = 0; i < rawAddresses.Count; i++)
        {
            var address = rawAddresses[i];
            var label = rawAddresses.Count > 1 ? $"Server {i + 1} — {address}" : address;
            slots.Add(new ServerSlot(address, label));
        }

        return slots;
    }

    private async Task<(List<ProcessStationUi>? Stations, DashboardServerError? Error)> FetchStationsForServerAsync(
        ServerSlot slot,
        CancellationToken cancellationToken)
    {
        try
        {
            var stations = await _openTestApiService.GetAllProcessStationsAsync(slot.Ip, cancellationToken);
            foreach (var station in stations)
            {
                station.ServerIp = slot.Label;
            }

            return (stations.ToList(), null);
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex, "Failed to reach OpenTest server at {ServerIp}", slot.Ip);
            return (null, new DashboardServerError
            {
                ServerIp = slot.Label,
                Error = $"Unable to connect to OpenTest server at {slot.Ip}. Ensure the server is running and reachable."
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Unexpected error fetching stations from {ServerIp}", slot.Ip);
            return (null, new DashboardServerError
            {
                ServerIp = slot.Label,
                Error = $"An unexpected error occurred while fetching station data from {slot.Ip}."
            });
        }
    }

    private sealed record ServerSlot(string Ip, string Label);
}
