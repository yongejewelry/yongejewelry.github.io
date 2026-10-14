Yonge Jewelry website

Start with Website-Setup-Guide.pdf. It shows every click with a picture.

website/                  The four website files. Upload all four to the shop's GitHub repository
                          (github.com > the repository > Add file > Upload files > Commit changes).
  index.html              the website itself
  products.json           the product list: names, prices, quantities (edit it on github.com)
  photos.json             every product photo, packed into one file
  settings.js             the Square codes and the payment helper address (edit it on github.com)
payments-worker.js        The payment helper. You paste it into a Cloudflare Worker (guide, Part 3).
                          It takes Square payments and sends the email and text receipts.
Website-Setup-Guide.pdf   The picture guide.

Three codes work like passwords: the Square access token, the Resend API key and the Twilio auth token.
They go only into Cloudflare's settings, as a Secret. Never put them in any of these files.

For a technical helper: the page also accepts photos as separate files at img/products/<id>.jpg if
photos.json is left out, and a product can name its own photo with "photo": "file.jpg" in products.json.
