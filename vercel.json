{
  "cleanUrls": true,
  "trailingSlash": false,
  "redirects": [
    { "source": "/", "destination": "/login", "permanent": false },
    { "source": "/index", "destination": "/login", "permanent": false }
  ],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "no-cache" }
      ]
    },
    {
      "source": "/img/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=604800" }
      ]
    }
  ]
}
