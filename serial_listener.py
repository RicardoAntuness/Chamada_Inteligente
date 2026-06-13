import requests

while True:

    uid = input("UID do cartão: ")

    response = requests.post(
        "http://localhost:3000/presenca",
        json={
            "uid": uid
        }
    )

    print(response.json())