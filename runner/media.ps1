# Ayudante que queda abierto y habla con los controles multimedia de Windows (los mismos del panel
# de volumen). Recibe "id<TAB>comando<TAB>argumento" por stdin y responde "id<TAB>json(base64)".
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

$src = Join-Path $PSScriptRoot 'AppVolume.cs'
$dll = Join-Path $PSScriptRoot 'AppVolume.dll'
# Compilar tarda unos segundos: se hace una vez y se reutiliza el .dll mientras el .cs no cambie.
if (-not (Test-Path $dll) -or (Get-Item $dll).LastWriteTime -lt (Get-Item $src).LastWriteTime) {
  try { Add-Type -Path $src -OutputAssembly $dll -OutputType Library } catch { Add-Type -Path $src; $dll = $null }
}
if ($dll) { Add-Type -Path $dll }

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
[void][Windows.Media.MediaPlaybackAutoRepeatMode, Windows.Media, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
[void][Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(3000)) { throw 'timeout' }
  $task.Result
}

$NS = 'Windows.Media.Control.GlobalSystemMediaTransportControlsSession'
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Type]"${NS}Manager")
$APP = 'Spotify'

function Get-Session { $mgr.GetSessions() | Where-Object { $_.SourceAppUserModelId -match $APP } | Select-Object -First 1 }

function Now {
  $s = Get-Session
  if (-not $s) { return @{ error = 'not-running' } }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Type]"${NS}MediaProperties")
  if (-not $p.Title) { return @{ error = 'idle' } }
  $pb = $s.GetPlaybackInfo(); $tl = $s.GetTimelineProperties()
  $playing = "$($pb.PlaybackStatus)" -eq 'Playing'
  $pos = $tl.Position.TotalMilliseconds
  # La posición vale para el momento en que Spotify la informó; si está sonando, se adelanta hasta ahora.
  if ($playing) { $pos += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalMilliseconds }
  $dur = ($tl.EndTime - $tl.StartTime).TotalMilliseconds
  $repeat = @{ None = 'off'; List = 'context'; Track = 'track' }["$($pb.AutoRepeatMode)"]
  @{
    state = $(if ($playing) { 'playing' } else { 'paused' })
    title = $p.Title; artists = $p.Artist; album = $p.AlbumTitle
    position = [math]::Round([math]::Min([math]::Max($pos, 0), $dur)); duration = [math]::Round($dur)
    shuffle = [bool]$pb.IsShuffleActive; repeat = $(if ($repeat) { $repeat } else { 'off' })
    volume = [AppVolume]::Get($APP)
    art = "$($p.Title)|$($p.AlbumTitle)|$($p.Artist)"
  }
}

function Art {
  $s = Get-Session
  if (-not $s) { return $null }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Type]"${NS}MediaProperties")
  if (-not $p.Thumbnail) { return $null }
  $stream = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  $net = $asStream.Invoke($null, @($stream))
  $ms = New-Object System.IO.MemoryStream
  $net.CopyTo($ms); $net.Dispose()
  $bytes = $ms.ToArray()
  $type = $(if ($bytes.Length -gt 0 -and $bytes[0] -eq 0x89) { 'image/png' } else { 'image/jpeg' })
  @{ key = "$($p.Title)|$($p.AlbumTitle)|$($p.Artist)"; data = "data:$type;base64," + [Convert]::ToBase64String($bytes) }
}

function Command($name, $arg) {
  if ($name -eq 'volume') { return @{ ok = [AppVolume]::Set($APP, [int]$arg) } }
  $s = Get-Session
  if (-not $s) { return @{ ok = $false } }
  $op = switch ($name) {
    'play-pause' { $s.TryTogglePlayPauseAsync() }
    'next'       { $s.TrySkipNextAsync() }
    'previous'   { $s.TrySkipPreviousAsync() }
    'seek-to'    { $s.TryChangePlaybackPositionAsync([long]([double]$arg * 10000000)) }
    'shuffle'    { $s.TryChangeShuffleActiveAsync($arg -eq 'on') }
    'repeat'     { $s.TryChangeAutoRepeatModeAsync([Windows.Media.MediaPlaybackAutoRepeatMode]@{ off = 'None'; context = 'List'; track = 'Track' }[$arg]) }
  }
  if (-not $op) { return @{ ok = $false } }
  @{ ok = [bool](Await $op ([bool])) }
}

[Console]::Out.WriteLine('ready')
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $p = $line.Split("`t")
  try {
    $result = switch ($p[1]) {
      'now' { Now }
      'art' { Art }
      default { Command $p[1] $p[2] }
    }
  } catch { $result = @{ error = 'failed'; message = "$_" } }
  $json = ConvertTo-Json $result -Compress -Depth 3
  [Console]::Out.WriteLine("$($p[0])`t" + [Convert]::ToBase64String($utf8.GetBytes("$json")))
}
