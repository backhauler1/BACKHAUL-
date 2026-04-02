from flask import Flask, request

app = Flask(__name__)

@app.route('/post-truck', methods=['POST'])
def receive_truck_details():
  truck_type = request.form.get('truck_type')
  departure_city = request.form.get('departure_city')
  destination_city = request.form.get('destination_city')
  start_date = request.form.get('start_date')
  end_date = request.form.get('end_date')
  shipper_counter = request.form.get('shipper_counter')

  # প্রমাণ করো যে ডেটা পাওয়া গেছে
  print(f'Received truck: {truck_type}, route: {departure_city} to {destination_city}, dates: {start_date} to {end_date}')
  
  return 'Truck details received!'

if __name__ == '__main__':
  app.run(debug=True)

