$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$project = Split-Path $PSScriptRoot -Parent
$source = Join-Path $project 'design-source'
$output = Join-Path $project 'dist/assets/designer'
New-Item -ItemType Directory -Path $output -Force | Out-Null
# Only copy original pixels or crop sprite regions / transparent padding. No repainting.
$regions = @(
    @('stage-background.png', '조달청_브리핑룸_3D배경_1920x1080.png', 0, 0, 1920, 1080),
    @('title-podium.png', '조달청_연단_3D_정면_투명.png', 180, 61, 783, 1254),
    @('result-panel.png', '하늘빛 프레임 결과 패널.png', 52, 72, 920, 1398),
    @('result-bird.png', '파란 고글 새와 배낭 다람쥐.png', 50, 28, 960, 920),
    @('result-backpack.png', '파란 고글 새와 배낭 다람쥐.png', 1055, 372, 470, 500),
    @('judge-nareumi.png', '나르미_3D_판사_투명.png', 196, 47, 808, 1173),
    @('judge-dali.png', '달이_3D_판사_소품제거_투명.png', 211, 50, 939, 1206),
    @('heart.png', '말랑한 빨간 하트 아이콘.png', 113, 216, 1014, 867),
    @('product-frame.png', '박스UI_3D_목재프레임_투명.png', 15, 23, 1555, 948),
    @('wooden-front.png', '목재단상_3D_정면_투명_1920x500.png', 8, 27, 1904, 445),
    @('bubble-box.png', '말풍선UI_박스_꼬리_분리시트.png', 10, 25, 1734, 655),
    @('bubble-tail-left.png', '말풍선UI_박스_꼬리_분리시트.png', 55, 705, 235, 180),
    @('bubble-tail-center.png', '말풍선UI_중앙꼬리_분리시트.png', 740, 700, 275, 185),
    @('audience-left.png', '세 가지 검은 뒷모습 실루엣.png', 45, 188, 545, 620),
    @('audience-center.png', '세 가지 검은 뒷모습 실루엣.png', 502, 326, 524, 583),
    @('audience-right.png', '세 가지 검은 뒷모습 실루엣.png', 988, 278, 494, 600)
)
$manifest = foreach ($region in $regions) {
    $sourceFile = Join-Path $source $region[1]
    $image = [System.Drawing.Bitmap]::FromFile($sourceFile)
    try {
        $rect = [System.Drawing.Rectangle]::new($region[2], $region[3], $region[4], $region[5])
        $crop = $image.Clone($rect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try { $crop.Save((Join-Path $output $region[0]), [System.Drawing.Imaging.ImageFormat]::Png) }
        finally { $crop.Dispose() }
    } finally { $image.Dispose() }
    [ordered]@{ file = $region[0]; source = $region[1]; crop = $region[2..5]; sourceSha256 = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash.ToLower() }
}
# The opening curtain uses the full supplied image, with no pixel changes.
$curtainSource = Join-Path $source '완전히 닫힌 보랏빛 무대 커튼.png'
Copy-Item -LiteralPath $curtainSource -Destination (Join-Path $output 'curtain-closed.png') -Force
$manifest += [ordered]@{ file = 'curtain-closed.png'; source = '완전히 닫힌 보랏빛 무대 커튼.png'; copyOriginal = $true; sourceSha256 = (Get-FileHash -LiteralPath $curtainSource -Algorithm SHA256).Hash.ToLower() }
# Result tiers use untouched Drive originals. CSS crops the left/right character
# of result-catchers.png so the two tiers share one lossless sprite sheet.
$resultSources = @(
    @('result-catchers.png', '그물 든 새와 호두 클립보드 다람쥐.png'),
    @('result-surprised.png', '고글 쓴 놀란 흰 새.png'),
    @('result-scientists.png', '로봇과 주황 동물 과학자.png'),
    @('result-officials.png', '다람쥐와 새 마스코트 투명 컷아웃.png')
)
foreach ($entry in $resultSources) {
    $sourceFile = Join-Path $source $entry[1]
    Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $output $entry[0]) -Force
    $manifest += [ordered]@{ file = $entry[0]; source = $entry[1]; copyOriginal = $true; sourceSha256 = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash.ToLower() }
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'manifest.json') -Encoding utf8
Write-Output "Prepared $($manifest.Count) designer assets."
