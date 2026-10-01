from flask import Flask, request, jsonify
import cv2
import pytesseract
import numpy as np
from PIL import Image
import re
import os
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = int(os.getenv('MAX_IMAGE_BYTES', 5 * 1024 * 1024))

# Configure Tesseract path through environment so Linux/Windows deployments can use the same code.
pytesseract.pytesseract.tesseract_cmd = os.getenv(
    'TESSERACT_CMD',
    r'C:\Program Files\Tesseract-OCR\tesseract.exe'
)


UPLOAD_FOLDER = 'captured_images'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

def preprocess_image(image):
    
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    
    bilateral = cv2.bilateralFilter(gray, 11, 17, 17)
    
    thresh = cv2.adaptiveThreshold(
        bilateral, 255, 
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C, 
        cv2.THRESH_BINARY, 11, 2
    )
    
    kernel = np.ones((3, 3), np.uint8)
    morph = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)
    
    return morph

def clean_license_plate(text):
    cleaned = re.sub(r'[^A-Z0-9]', '', text.upper())
    
    patterns = [
        r'^[A-Z]{2}[0-9]{2}[A-Z]{1,2}[0-9]{4}$',  
        r'^[A-Z]{3}[0-9]{4}$',                     
        r'^[0-9]{1,3}[A-Z]{1,3}[0-9]{1,4}$',       
    ]
    
    
    for pattern in patterns:
        if re.match(pattern, cleaned):
            return cleaned
    
   
    return cleaned if len(cleaned) >= 4 else None

def detect_license_plate(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    
    edges = cv2.Canny(gray, 30, 200)
    
    contours, _ = cv2.findContours(edges, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:10]
    
    license_plate = None
    
    for contour in contours:
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.018 * perimeter, True)
        
        if len(approx) == 4:  # Rectangle
            x, y, w, h = cv2.boundingRect(approx)
            aspect_ratio = w / float(h)
            
            # License plates typically have aspect ratio between 2:1 and 5:1
            if 2.0 <= aspect_ratio <= 5.0:
                license_plate = image[y:y+h, x:x+w]
                break
    
    return license_plate

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'OK', 'service': 'OCR Service'}), 200

@app.route('/recognize', methods=['POST'])
def recognize_plate():
    try:
        if 'image' not in request.files:
            return jsonify({'error': 'No image provided'}), 400
        
        file = request.files['image']
        
        if file.filename == '':
            return jsonify({'error': 'No image selected'}), 400
        
        image_bytes = file.read()
        nparr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if image is None:
            return jsonify({'error': 'Invalid image format'}), 400
        
        plate_region = detect_license_plate(image)
        
        ocr_image = plate_region if plate_region is not None else image
        
        processed = preprocess_image(ocr_image)
        
        configs = [
            '--psm 7 --oem 3 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
            '--psm 8 --oem 3 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
            '--psm 6 --oem 3 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
            '--psm 7 --oem 3',  
            '--psm 8 --oem 3'
        ]
        
        images_to_try = [
            ('original', ocr_image),
            ('processed', processed)
        ]
        
        best_result = None
        best_confidence = 0
        
        # Try each image with each configuration
        for img_name, img in images_to_try:
            for config in configs:
                try:
                    data = pytesseract.image_to_data(
                        img, 
                        config=config, 
                        output_type=pytesseract.Output.DICT
                    )
                    
                    text = ' '.join([data['text'][i] for i in range(len(data['text'])) 
                                    if int(data['conf'][i]) > 0])
                    
                    confidences = [int(data['conf'][i]) for i in range(len(data['conf'])) 
                                  if int(data['conf'][i]) > 0]
                    avg_confidence = sum(confidences) / len(confidences) if confidences else 0
                    
                    if avg_confidence > best_confidence:
                        best_confidence = avg_confidence
                        best_result = text
                        print(f"Trying {img_name} with config '{config}': '{text}' (confidence: {avg_confidence})")
                except Exception as e:
                    print(f"OCR config failed for {img_name}: {e}")
                    continue
        
        if best_result:
            cleaned_plate = clean_license_plate(best_result)
            
            if cleaned_plate:
                timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
                image_filename = f"{cleaned_plate}_{timestamp}.jpg"
                image_path = os.path.join(UPLOAD_FOLDER, image_filename)
                cv2.imwrite(image_path, image)
                
                return jsonify({
                    'success': True,
                    'license_plate': cleaned_plate,
                    'raw_text': best_result,
                    'confidence': best_confidence / 100,
                    'image_path': image_path
                }), 200
            else:
                return jsonify({
                    'success': False,
                    'error': 'Could not extract valid license plate',
                    'raw_text': best_result
                }), 200
        else:
            return jsonify({
                'success': False,
                'error': 'No text detected in image'
            }), 200
            
    except Exception as e:
        print(f"Error processing image: {str(e)}")
        return jsonify({'error': 'Processing failed'}), 500

@app.route('/recognize-base64', methods=['POST'])
def recognize_plate_base64():
    """Recognize license plate from base64 image"""
    try:
        data = request.get_json()
        
        if 'image' not in data:
            return jsonify({'error': 'No image data provided'}), 400
        
        import base64
        
        raw_base64 = data.get('image', '')
        if not isinstance(raw_base64, str) or len(raw_base64) > 8 * 1024 * 1024:
            return jsonify({'error': 'Image is too large'}), 413
        image_data = base64.b64decode(raw_base64, validate=True)
        if len(image_data) > app.config['MAX_CONTENT_LENGTH']:
            return jsonify({'error': 'Image is too large'}), 413
        nparr = np.frombuffer(image_data, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if image is None:
            return jsonify({'error': 'Invalid image format'}), 400
        
        plate_region = detect_license_plate(image)
        ocr_image = plate_region if plate_region is not None else image
        processed = preprocess_image(ocr_image)
        
        text = pytesseract.image_to_string(
            processed,
            config='--psm 7 --oem 3 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
        )
        
        cleaned_plate = clean_license_plate(text)
        
        if cleaned_plate:
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            image_filename = f"{cleaned_plate}_{timestamp}.jpg"
            image_path = os.path.join(UPLOAD_FOLDER, image_filename)
            cv2.imwrite(image_path, image)
            
            return jsonify({
                'success': True,
                'license_plate': cleaned_plate,
                'raw_text': text,
                'image_path': image_path
            }), 200
        else:
            return jsonify({
                'success': False,
                'error': 'Could not extract valid license plate',
                'raw_text': text
            }), 200
            
    except Exception as e:
        return jsonify({'error': 'Processing failed'}), 500

if __name__ == '__main__':
   
    app.run(host=os.getenv('OCR_HOST', '127.0.0.1'), port=int(os.getenv('OCR_PORT', 5000)), debug=False)
