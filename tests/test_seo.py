import pytest

from set_game.app import create_app


@pytest.fixture(scope="module")
def app():
    return create_app()


def test_home_exposes_search_and_social_metadata(app):
    with app.test_client() as client:
        response = client.get("/")

    html = response.get_data(as_text=True)
    assert response.status_code == 200
    assert (
        "<title>Play SET Online with Friends | Private Multiplayer Game</title>" in html
    )
    assert 'name="description"' in html
    assert 'name="robots"' in html
    assert 'content="index, follow, max-image-preview:large, max-snippet:-1"' in html
    assert 'rel="canonical"' in html
    assert 'property="og:image"' in html
    assert 'name="twitter:card" content="summary_large_image"' in html
    assert 'itemtype="https://schema.org/VideoGame"' in html


def test_private_rooms_are_not_indexable(app):
    with app.test_client() as client:
        response = client.get("/room/ABCDE234FG")

    html = response.get_data(as_text=True)
    assert response.status_code == 200
    assert response.headers["X-Robots-Tag"] == "noindex, nofollow, noarchive"
    assert 'content="noindex, nofollow, noarchive"' in html
    assert 'rel="canonical"' not in html


def test_robots_excludes_ephemeral_routes_and_links_sitemap(app):
    with app.test_client() as client:
        response = client.get("/robots.txt")

    body = response.get_data(as_text=True)
    assert response.status_code == 200
    assert response.mimetype == "text/plain"
    assert "Disallow: /room/" in body
    assert "Disallow: /healthz" in body
    assert "Sitemap: http://localhost/sitemap.xml" in body


def test_sitemap_contains_only_the_public_home_page(app):
    with app.test_client() as client:
        response = client.get("/sitemap.xml")

    body = response.get_data(as_text=True)
    assert response.status_code == 200
    assert response.mimetype == "application/xml"
    assert "<loc>http://localhost/</loc>" in body
    assert "/room/" not in body
