# BoxMap

A lightweight Docker web app for scanning QR codes on boxes and items. Scan a code to instantly see what's inside a box or where an item is stored.

## Features

- **QR Code Scanning** - Enter codes manually or use camera
- **Box Management** - Track what's inside each box
- **Item Management** - Track where each item is stored
- **Image Support** - Upload images for boxes and items
- **PDF Label Generation** - Print labels with multiple template options
- **Dark Mode** - Easy on the eyes
- **Admin Panel** - Password-protected management UI
- **Image Recognition Toggle** - Optional AI-powered item recognition
- **Lightweight** - SQLite database, no external dependencies

## Quick Start

### Docker (Recommended)

```bash
docker run -d \
  --name boxmap \
  -p 3000:3000 \
  -v boxmap-data:/app/data \
  -v boxmap-uploads:/app/uploads \
  -e ADMIN_PASSWORD=yourpassword \
  ghcr.io/stuffzez/boxmap:latest
```

### Docker Compose

Create a `docker-compose.yml`:

```yaml
services:
  boxmap:
    image: ghcr.io/stuffzez/boxmap:latest
    container_name: boxmap
    ports:
      - "3000:3000"
    volumes:
      - boxmap-data:/app/data
      - boxmap-uploads:/app/uploads
    environment:
      - ADMIN_PASSWORD=yourpassword
      - PORT=3000
      - IMAGE_RECOGNITION_ENABLED=false
    restart: unless-stopped

volumes:
  boxmap-data:
  boxmap-uploads:
```

Then run:

```bash
docker-compose up -d
```

### Build from Source

```bash
git clone https://github.com/StuffzEZ/BoxMap.git
cd BoxMap
docker-compose up -d --build
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_PASSWORD` | `admin123` | Password for admin panel |
| `PORT` | `3000` | Server port |
| `IMAGE_RECOGNITION_ENABLED` | `false` | Enable image recognition (items only) |
| `APP_URL` | `http://localhost:<PORT>` | Public URL of the app used when encoding QR codes (should include protocol and port) |

## Usage

### APP_URL and QR behavior

- `APP_URL` should be set to the externally reachable URL of your BoxMap instance, including protocol and port (for example `https://boxmap.example.com:3962` or `http://localhost:3000`).
- When generating QR codes, the app encodes full URLs like: `${APP_URL}?id=BOX1234567890`. External scanners will open the app URL. The in-app scanner automatically strips the `?id=` prefix and uses only the ID when querying the API.
- For live camera access from mobile devices, serve the app over HTTPS or use `localhost`/a trusted certificate — browsers require a secure context for `getUserMedia()`.


### Scanner (http://localhost:3000)

1. Enter a QR code (e.g., `BOX1234567890` or `ITM1234567890`)
2. Click **Scan**
3. View results:
   - **Box**: Shows all items inside the box
   - **Item**: Shows which box it's in and its location

### Admin Panel (http://localhost:3000/admin)

1. Login with admin password
2. View stats (total boxes, items, unassigned)
3. Manage boxes and items (CRUD operations)
4. Generate PDF labels

### QR Code Format

| Type | Format | Example |
|------|--------|---------|
| Box | `BOX` + 10 digits | `BOX1234567890` |
| Item | `ITM` + 10 digits | `ITM1234567890` |

### Label Generation

1. Go to Admin Panel > Labels tab
2. Select IDs (comma separated) or use Quick Select
3. Choose a template:
   - **DYMO 30252** - 14 labels with borders
   - **Borderless 14** - 14 labels without borders
   - **Avery 5160** - 30 labels, no border
   - **Avery 5161** - 40 labels, no border
   - **Avery 5162** - 21 labels, no border
4. Set start index (for partial sheets)
5. Click **Generate PDF**

Labels are designed with QR code on the left and info on the right for cable wrap compatibility.

## API Endpoints

### Public

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/scan` | Scan a QR code |
| `GET` | `/api/settings` | Get app settings |
| `GET` | `/api/labels/templates` | Get label template options |

### Admin (requires `X-Admin-Password` header)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/stats` | Get dashboard stats |
| `GET` | `/api/boxes` | List all boxes |
| `GET` | `/api/boxes/:id` | Get box details |
| `POST` | `/api/boxes` | Create box |
| `PUT` | `/api/boxes/:id` | Update box |
| `DELETE` | `/api/boxes/:id` | Delete box |
| `GET` | `/api/items` | List all items |
| `GET` | `/api/items/:id` | Get item details |
| `POST` | `/api/items` | Create item |
| `PUT` | `/api/items/:id` | Update item |
| `DELETE` | `/api/items/:id` | Delete item |
| `GET` | `/api/labels/pdf` | Generate PDF labels |

## GitHub Actions

The repository includes a GitHub Actions workflow that automatically:

- Builds the Docker image on push to `main`
- Pushes to GitHub Container Registry as `ghcr.io/stuffsez/boxmap:latest`
- Caches layers for faster builds

### Manual Trigger

You can also trigger the workflow manually from the Actions tab.

## Project Structure

```
BoxMap/
├── .github/
│   └── workflows/
│       └── docker.yml      # CI/CD pipeline
├── public/
│   ├── css/
│   │   └── style.css       # Dark mode styles
│   ├── admin.html          # Admin panel UI
│   └── index.html          # Scanner UI
├── data/                   # SQLite database (created at runtime)
├── uploads/
│   └── images/             # Uploaded images (created at runtime)
├── docker-compose.yml      # Docker orchestration
├── Dockerfile              # Container build
├── package.json            # Dependencies
├── server.js               # Backend API
└── README.md               # This file
```

## License

MIT
