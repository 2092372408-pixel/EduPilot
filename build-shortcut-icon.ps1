param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Destination
)

Add-Type -AssemblyName System.Drawing
$image = [Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Source).Path)
$bitmap = New-Object Drawing.Bitmap(256, 256)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.DrawImage($image, 0, 0, 256, 256)
$png = New-Object IO.MemoryStream
$bitmap.Save($png, [Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
$image.Dispose()
$payload = $png.ToArray()
$png.Dispose()

$file = [IO.File]::Create($Destination)
try {
  $writer = New-Object IO.BinaryWriter($file)
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]1)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]32)
  $writer.Write([uint32]$payload.Length)
  $writer.Write([uint32]22)
  $writer.Write($payload)
  $writer.Flush()
} finally {
  $file.Dispose()
}
